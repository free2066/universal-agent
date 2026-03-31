import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, relative, join, dirname } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../models/types.js';

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
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = ((args.start_line as number) || 1) - 1;
      const end = (args.end_line as number) || lines.length;
      const slice = lines.slice(start, end);
      return slice.map((line, i) => `${String(start + i + 1).padStart(6)}│ ${line}`).join('\n');
    } catch (err) {
      return `Error reading file: ${err}`;
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
      writeFileSync(filePath, args.content as string, 'utf-8');
      const lines = (args.content as string).split('\n').length;
      return `✓ Written ${lines} lines to ${filePath}`;
    } catch (err) {
      return `Error writing file: ${err}`;
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
      const content = readFileSync(filePath, 'utf-8');
      const oldStr = args.old_string as string;
      if (!content.includes(oldStr)) {
        return `Error: old_string not found in file. Make sure it matches exactly (including whitespace).`;
      }
      const newContent = content.replace(oldStr, args.new_string as string);
      writeFileSync(filePath, newContent, 'utf-8');
      return `✓ Edit applied to ${filePath}`;
    } catch (err) {
      return `Error editing file: ${err}`;
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

    // Blocked dangerous patterns in safe mode
    const isSafe = process.env.AGENT_SAFE_MODE === '1';
    if (isSafe) {
      const dangerous = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :|:& };:/];
      for (const pat of dangerous) {
        if (pat.test(command)) return `Blocked in safe mode: potentially destructive command`;
      }
    }

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
      const stderr = e.stderr?.trim() || '';
      const stdout = e.stdout?.trim() || '';
      const msg = e.message || String(err);
      return [stdout, stderr, `Exit error: ${msg}`].filter(Boolean).join('\n');
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

    function listDir(dir: string, depth: number = 0): string[] {
      const entries = readdirSync(dir);
      const lines: string[] = [];
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        const indent = '  '.repeat(depth);
        const relPath = relative(dirPath, full);
        if (stat.isDirectory()) {
          lines.push(`${indent}📁 ${relPath}/`);
          if (args.recursive && depth < 3) lines.push(...listDir(full, depth + 1));
        } else {
          const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
          lines.push(`${indent}📄 ${relPath} (${size})`);
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
    const includeFlag = filePattern ? `--include="${filePattern}"` : '';

    try {
      const cmd = `grep -rn ${caseFlag} ${includeFlag} --exclude-dir=node_modules --exclude-dir=.git -E "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -50`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 }).trim();
      return output || `No matches found for pattern: ${pattern}`;
    } catch {
      return `No matches found for pattern: ${pattern}`;
    }
  },
};
