import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, relative, join, dirname } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../models/types.js';
import { mmrRerankGrepResults } from '../mmr.js';

// ─── Read File ──────────────────────────────────────────
export const readFileTool: ToolRegistration = {
  definition: {
    name: 'Read',
    description: 'Read the contents of a file. Returns file content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        start_line: { type: 'number', description: 'Start line number (1-indexed, optional)' },
        end_line: { type: 'number', description: 'End line number (1-indexed, optional)' },
      },
      required: ['file_path'],
    },
  },
  handler: async (args) => {
    const filePath = resolve(process.cwd(), args.file_path as string);
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    try {
      // Bug b6: detect directory and return friendly message (statSync already imported at top)
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, ((args.start_line as number) || 1) - 1);
      const end = Math.min(lines.length, (args.end_line as number) || lines.length);
      const slice = lines.slice(start, end);
      return slice.map((line, i) => `${String(start + i + 1).padStart(6)}│ ${line}`).join('\n');
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Write File ─────────────────────────────────────────
export const writeFileTool: ToolRegistration = {
  definition: {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  handler: async (args) => {
    const filePath = resolve(process.cwd(), args.file_path as string);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const content = args.content as string;
      writeFileSync(filePath, content, 'utf-8');
      const lines = content.split('\n').length;
      return `✓ Written ${lines} lines to ${filePath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Edit File (Replace) ─────────────────────────────────
export const editFileTool: ToolRegistration = {
  definition: {
    name: 'Edit',
    description: 'Replace an exact string in a file. Use this for surgical edits.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to edit' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Text to replace it with' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  handler: async (args) => {
    const filePath = resolve(process.cwd(), args.file_path as string);
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    try {
      // Bug #6 (BUG_REPORT_TESTED): detect directory and return friendly message instead of EISDIR crash
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }
      const content = readFileSync(filePath, 'utf-8');
      const oldStr = args.old_string as string;
      if (!content.includes(oldStr)) {
        return `Error: old_string not found in file. Make sure it matches exactly (including whitespace).`;
      }
      // Replace only the first occurrence (safer than replaceAll)
      const newContent = content.replace(oldStr, (args.new_string as string).replace(/\$/g, '$$$$'));
      writeFileSync(filePath, newContent, 'utf-8');
      return `✓ Edit applied to ${filePath}`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Bash Tool ───────────────────────────────────────────
export const bashTool: ToolRegistration = {
  definition: {
    name: 'Bash',
    description: 'Execute a shell command and return the output. Use for running tests, builds, git commands, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (default: current directory)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
  handler: async (args) => {
    const command = args.command as string;
    const cwd = args.cwd ? resolve(process.cwd(), args.cwd as string) : process.cwd();
    const timeout = (args.timeout as number) || 30000;

    // Safe mode: dangerous commands require explicit user confirmation before execution.
    // Inspired by kstack article #15313 — dry-run + confirm flow instead of hard block.
    //
    // HARD BLOCK: fork bombs and direct block-device writes are always blocked (no confirm possible).
    // SOFT BLOCK: other destructive commands return a __CONFIRM_REQUIRED__ sentinel so the
    //             agent loop can pause, show a dry-run summary, and resume only after the user says yes.
    const isSafe = process.env.AGENT_SAFE_MODE === '1';
    if (isSafe) {
      // Always-block patterns (catastrophic / unrecoverable)
      const hardBlock = [
        /:\(\)\s*\{\s*:|:\&\s*\}/,   // fork bomb
        /:\(\)\{:\|:&\}/,
        />\s*\/dev\/[sh]d[a-z]\d*/,  // write to block device
        />\s*\/dev\/nvme/,
      ];
      for (const pat of hardBlock) {
        if (pat.test(command)) {
          return `Blocked in safe mode: catastrophic command not allowed.\n  Pattern matched: ${pat}`;
        }
      }

      // Soft-block patterns — require user confirmation (dry-run then confirm)
      const softBlock: Array<{ pat: RegExp; label: string }> = [
        { pat: /rm\s+-[^\s]*r[^\s]*\s+\/[^\s]*/, label: 'recursive delete from root path' },
        { pat: /rm\s+-rf\s+/,                     label: 'recursive force delete' },
        { pat: /mkfs/,                              label: 'filesystem format' },
        { pat: /dd\s+if=/,                         label: 'raw disk copy (dd)' },
        { pat: /\|\s*(ba|z|da)?sh\s*$/,            label: 'pipe to shell (code execution)' },
        { pat: /\|\s*(ba|z|da)?sh\s+-/,            label: 'pipe to shell (code execution)' },
        { pat: /sudo\s+rm\s+-[^\s]*r/,             label: 'sudo recursive delete' },
        { pat: /sudo\s+mkfs/,                       label: 'sudo filesystem format' },
        { pat: /sudo\s+dd\s/,                       label: 'sudo raw disk copy' },
        { pat: />\s*\/(etc|bin|sbin|lib|usr|boot)\/[^\s]*/, label: 'overwrite system file' },
        { pat: /git\s+push\s+.*--force/,            label: 'force git push' },
        { pat: /git\s+push\s+.*-f\b/,              label: 'force git push' },
        { pat: /chmod\s+-R\s+[0-7]*7[0-7]*\s+\//,  label: 'recursive world-writable chmod on root' },
      ];
      for (const { pat, label } of softBlock) {
        if (pat.test(command)) {
          // Return sentinel so agent.ts can pause and ask for user confirmation
          return `__CONFIRM_REQUIRED__:${label}\n${command}`;
        }
      }
    }

    // Validate cwd exists
    if (!existsSync(cwd)) return `Error: Working directory not found: ${cwd}`;

    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no output)';
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const parts: string[] = [];
      if (e.stdout?.trim()) parts.push(e.stdout.trim());
      if (e.stderr?.trim()) parts.push(e.stderr.trim());
      // Avoid double-printing the message if it's already in stderr
      if (!e.stderr && e.message) parts.push(`Exit error: ${e.message}`);
      return parts.join('\n') || `Command failed`;
    }
  },
};

// ─── List Files ──────────────────────────────────────────
export const listFilesTool: ToolRegistration = {
  definition: {
    name: 'LS',
    description: 'List files and directories at a path. Shows file sizes and types.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (default: current directory)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
    },
  },
  handler: async (args) => {
    const dirPath = resolve(process.cwd(), (args.path as string) || '.');
    if (!existsSync(dirPath)) return `Error: Path not found: ${dirPath}`;

    const recursive = args.recursive as boolean | undefined;

    function listDir(dir: string, depth: number = 0): string[] {
      const lines: string[] = [];
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [`${' '.repeat(depth * 2)}(unreadable)`];
      }

      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          const indent = '  '.repeat(depth);
          const relPath = relative(dirPath, full);
          if (stat.isDirectory()) {
            lines.push(`${indent}📁 ${relPath}/`);
            if (recursive && depth < 3) lines.push(...listDir(full, depth + 1));
          } else {
            const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
            lines.push(`${indent}📄 ${relPath} (${size})`);
          }
        } catch {
          // Skip unreadable entries (e.g. broken symlinks)
        }
      }
      return lines;
    }

    const lines = listDir(dirPath);
    return lines.join('\n') || '(empty directory)';
  },
};

// ─── Grep Tool ───────────────────────────────────────────
export const grepTool: ToolRegistration = {
  definition: {
    name: 'Grep',
    description: 'Search for a pattern in files using regex. Returns matching lines with file:line context.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
        file_pattern: { type: 'string', description: 'File glob pattern like *.ts, *.py (optional)' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive search (default: true)' },
      },
      required: ['pattern'],
    },
  },
  handler: async (args) => {
    const searchPath = resolve(process.cwd(), (args.path as string) || '.');
    const pattern = args.pattern as string;
    const filePattern = args.file_pattern as string | undefined;
    const caseFlag = args.case_sensitive === false ? '-i' : '';
    // Safe-quote the include flag
    const escapedFilePattern = filePattern ? filePattern.replace(/'/g, "'\"'\"'") : '';
    const includeFlag = escapedFilePattern ? `--include='${escapedFilePattern}'` : '';

    // Escape the search path to prevent shell injection (single-quote with escaping)
    const escapedSearchPath = searchPath.replace(/'/g, "'\"'\"'");

    // Bug #8: validate regex before passing to grep to give a clear syntax error
    try {
      new RegExp(pattern);
    } catch (regexErr) {
      return `Error: Invalid regular expression pattern: ${regexErr instanceof Error ? regexErr.message : String(regexErr)}\n  Pattern: ${pattern}\n  Tip: escape special chars like ( ) [ ] { } . * + ? ^ $ | with a backslash`;
    }

    try {
      // Escape the pattern for shell — use single quotes to avoid most injection
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'");
      const cmd = [
        'grep', '-rn', caseFlag, includeFlag,
        '--exclude-dir=node_modules', '--exclude-dir=.git',
        '-E', `'${escapedPattern}'`,
        `'${escapedSearchPath}'`,
        '2>/dev/null', '| head -50',
      ].filter(Boolean).join(' ');

      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 }).trim();
      if (!output) return `No matches found for pattern: ${pattern}`;

      // Parse raw grep output into structured results for MMR reranking
      const lines = output.split('\n');
      const grepResults = lines.map((line, i) => {
        const m = line.match(/^(.+?):(\d+):(.*)/);
        return m
          ? { file: m[1], line: parseInt(m[2], 10), content: m[3] }
          : { file: '', line: i, content: line };
      });

      // Apply MMR to reduce redundant results from the same file
      const mmrEnabled = process.env.AGENT_MMR !== '0';
      const reranked = mmrRerankGrepResults(grepResults, { enabled: mmrEnabled, lambda: 0.7 });

      return reranked
        .map((r) => r.file ? `${r.file}:${r.line}:${r.content}` : r.content)
        .join('\n');
    } catch {
      return `No matches found for pattern: ${pattern}`;
    }
  },
};
