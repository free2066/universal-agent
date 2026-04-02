import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, createReadStream } from 'fs';
import { resolve, relative, join, dirname } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import type { ToolRegistration } from '../../models/types.js';
import { mmrRerankGrepResults } from '../mmr.js';

// ─── Output truncation (inspired by opencode truncate.ts) ────────────────────
/** Lines / bytes beyond which tool output is considered "large" */
const TRUNCATE_MAX_LINES = 2000;
const TRUNCATE_MAX_BYTES = 50 * 1024; // 50 KB

/**
 * Truncate a string to at most TRUNCATE_MAX_LINES / TRUNCATE_MAX_BYTES.
 * Returns the (possibly shortened) string and a truncated flag.
 */
function truncateOutput(
  text: string,
  maxLines = TRUNCATE_MAX_LINES,
  maxBytes = TRUNCATE_MAX_BYTES,
): { content: string; truncated: boolean; removedLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { content: text, truncated: false, removedLines: 0 };
  }
  // Trim by lines first
  let kept = Math.min(lines.length, maxLines);
  // Trim further if still over byte limit
  let preview = lines.slice(0, kept).join('\n');
  while (kept > 1 && Buffer.byteLength(preview, 'utf-8') > maxBytes) {
    kept = Math.floor(kept * 0.9);
    preview = lines.slice(0, kept).join('\n');
  }
  const removedLines = lines.length - kept;
  const hint =
    `\n\n(Output truncated: showing ${kept} of ${lines.length} lines. ` +
    `Use Grep to search the full content, or Read with start_line/end_line to view specific sections.)`;
  return { content: preview + hint, truncated: true, removedLines };
}

// ─── Read File ──────────────────────────────────────────
export const readFileTool: ToolRegistration = {
  definition: {
    name: 'Read',
    description:
      'Read the contents of a file with optional pagination. Returns file content with line numbers. ' +
      'Use offset+limit for large files to avoid context overflow.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        start_line: { type: 'number', description: 'Start line number (1-indexed, optional). Alias for offset.' },
        end_line: { type: 'number', description: 'End line number (1-indexed, optional). If omitted reads to file end or limit.' },
        offset: { type: 'number', description: 'First line to read (1-indexed). Takes priority over start_line if both provided.' },
        limit: { type: 'number', description: `Max number of lines to return (default: ${TRUNCATE_MAX_LINES}). Use with offset for pagination.` },
      },
      required: ['file_path'],
    },
  },
  handler: async (args) => {
    const filePath = resolve(process.cwd(), args.file_path as string);
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    try {
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }

      // Resolve offset / limit (new API) with fallback to start_line / end_line (legacy)
      const offsetArg = (args.offset as number | undefined) ?? (args.start_line as number | undefined);
      const offset = offsetArg !== undefined ? Math.max(1, offsetArg) : 1;
      const limitArg = args.limit as number | undefined;
      // end_line takes precedence over limit when offset is 1 (legacy callers)
      const endLineArg = args.end_line as number | undefined;

      const content = readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      const start = offset - 1; // 0-indexed
      let end: number;
      if (endLineArg !== undefined) {
        end = Math.min(totalLines, endLineArg);
      } else if (limitArg !== undefined) {
        end = Math.min(totalLines, start + limitArg);
      } else {
        end = Math.min(totalLines, start + TRUNCATE_MAX_LINES);
      }

      const slice = allLines.slice(start, end);
      const result = slice.map((line, i) => `${String(start + i + 1).padStart(6)}│ ${line}`).join('\n');

      const hasMore = end < totalLines;
      if (hasMore) {
        const nextOffset = end + 1;
        return (
          result +
          `\n\n(Showing lines ${offset}-${end} of ${totalLines}. ` +
          `Use offset=${nextOffset} to continue reading.)`
        );
      }

      // Also apply byte-level truncation for very wide lines
      const { content: final, truncated, removedLines } = truncateOutput(result);
      if (truncated) {
        return final + `\n(${removedLines} additional lines hidden — use offset/limit to paginate)`;
      }
      return result + `\n\n(End of file — ${totalLines} lines total)`;
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
      // Compute diff summary if file already exists
      let diffSummary = '';
      if (existsSync(filePath)) {
        try {
          const oldContent = readFileSync(filePath, 'utf-8');
          const oldLines = oldContent.split('\n').length;
          const newLines = content.split('\n').length;
          diffSummary = ` (${oldLines}→${newLines} lines)`;
        } catch { /* ignore diff errors */ }
      }
      writeFileSync(filePath, content, 'utf-8');
      const lines = content.split('\n').length;
      return `✓ Written ${lines} lines to ${filePath}${diffSummary}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Edit File Fuzzy Replacers (inspired by opencode edit.ts) ────────────────
// Sources: cline diff-apply, google-gemini editCorrector, opencode edit.ts

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

function levenshtein(a: string, b: string): number {
  if (!a || !b) return Math.max(a.length, b.length);
  const m = Array.from({ length: a.length + 1 }, (_: unknown, i: number) =>
    Array.from({ length: b.length + 1 }, (_2: unknown, j: number) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  return m[a.length][b.length];
}

const SimpleReplacer: Replacer = function* (_c, find) { yield find; };

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const orig = content.split('\n'); const search = find.split('\n');
  if (search[search.length - 1] === '') search.pop();
  for (let i = 0; i <= orig.length - search.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) if (orig[i + j].trim() !== search[j].trim()) { ok = false; break; }
    if (!ok) continue;
    let s = 0; for (let k = 0; k < i; k++) s += orig[k].length + 1;
    let e = s; for (let k = 0; k < search.length; k++) { e += orig[i + k].length; if (k < search.length - 1) e++; }
    yield content.substring(s, e);
  }
};

const BlockAnchorReplacer: Replacer = function* (content, find) {
  const orig = content.split('\n'); const search = find.split('\n');
  if (search.length < 3) return;
  if (search[search.length - 1] === '') search.pop();
  const first = search[0].trim(); const last = search[search.length - 1].trim();
  const candidates: Array<{ s: number; e: number }> = [];
  for (let i = 0; i < orig.length; i++) {
    if (orig[i].trim() !== first) continue;
    for (let j = i + 2; j < orig.length; j++)
      if (orig[j].trim() === last) { candidates.push({ s: i, e: j }); break; }
  }
  if (!candidates.length) return;
  function extractMatch(s: number, e: number) {
    let ms = 0; for (let k = 0; k < s; k++) ms += orig[k].length + 1;
    let me = ms; for (let k = s; k <= e; k++) { me += orig[k].length; if (k < e) me++; }
    return content.substring(ms, me);
  }
  if (candidates.length === 1) { yield extractMatch(candidates[0].s, candidates[0].e); return; }
  let best = candidates[0]; let bestSim = -1;
  for (const c of candidates) {
    const lines = Math.min(search.length - 2, c.e - c.s - 1);
    let sim = lines > 0 ? 0 : 1;
    for (let j = 1; j < search.length - 1 && j < c.e - c.s; j++) {
      const ml = Math.max(orig[c.s + j].trim().length, search[j].trim().length);
      if (ml) sim += 1 - levenshtein(orig[c.s + j].trim(), search[j].trim()) / ml;
    }
    if (lines > 0) sim /= lines;
    if (sim > bestSim) { bestSim = sim; best = c; }
  }
  if (bestSim >= 0.3) yield extractMatch(best.s, best.e);
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const nw = (t: string) => t.replace(/\s+/g, ' ').trim();
  const nf = nw(find);
  const lines = content.split('\n');
  for (const line of lines) if (nw(line) === nf) { yield line; return; }
  const fl = find.split('\n');
  if (fl.length > 1)
    for (let i = 0; i <= lines.length - fl.length; i++) {
      const block = lines.slice(i, i + fl.length);
      if (nw(block.join('\n')) === nf) { yield block.join('\n'); return; }
    }
};

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const strip = (t: string) => {
    const ls = t.split('\n'); const ne = ls.filter(l => l.trim());
    if (!ne.length) return t;
    const min = Math.min(...ne.map(l => (l.match(/^(\s*)/) ?? ['', ''])[1].length));
    return ls.map(l => l.trim() ? l.slice(min) : l).join('\n');
  };
  const sf = strip(find); const cl = content.split('\n'); const fl = find.split('\n');
  for (let i = 0; i <= cl.length - fl.length; i++) {
    const block = cl.slice(i, i + fl.length).join('\n');
    if (strip(block) === sf) { yield block; return; }
  }
};

const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, c: string) =>
    ({ n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', '$': '$' }[c] ?? c));
  const uf = unescape(find);
  if (content.includes(uf)) { yield uf; return; }
  const fl = uf.split('\n'); const lines = content.split('\n');
  for (let i = 0; i <= lines.length - fl.length; i++) {
    const block = lines.slice(i, i + fl.length).join('\n');
    if (unescape(block) === uf) { yield block; return; }
  }
};

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const tf = find.trim();
  if (tf === find) return;
  if (content.includes(tf)) { yield tf; return; }
  const fl = find.split('\n'); const lines = content.split('\n');
  for (let i = 0; i <= lines.length - fl.length; i++) {
    const block = lines.slice(i, i + fl.length).join('\n');
    if (block.trim() === tf) { yield block; return; }
  }
};

const ContextAwareReplacer: Replacer = function* (content, find) {
  const fl = find.split('\n');
  if (fl.length < 3) return;
  if (fl[fl.length - 1] === '') fl.pop();
  const cl = content.split('\n');
  const fst = fl[0].trim(); const lst = fl[fl.length - 1].trim();
  for (let i = 0; i < cl.length; i++) {
    if (cl[i].trim() !== fst) continue;
    for (let j = i + 2; j < cl.length; j++) {
      if (cl[j].trim() !== lst) continue;
      const block = cl.slice(i, j + 1);
      if (block.length !== fl.length) break;
      let match = 0, total = 0;
      for (let k = 1; k < block.length - 1; k++) {
        if (block[k].trim() || fl[k].trim()) { total++; if (block[k].trim() === fl[k].trim()) match++; }
      }
      if (!total || match / total >= 0.5) { yield block.join('\n'); return; }
      break;
    }
  }
};

const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let s = 0;
  while (true) { const i = content.indexOf(find, s); if (i === -1) break; yield find; s = i + find.length; }
};

/**
 * Attempt to replace oldStr in content using a cascade of 9 fuzzy strategies.
 * Inspired by opencode's replace() function (edit.ts).
 */
function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null {
  // Normalise line endings before attempting
  const normalized = content.replace(/\r\n/g, '\n');
  const normOld = oldStr.replace(/\r\n/g, '\n');

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const match of replacer(normalized, normOld)) {
      const idx = normalized.indexOf(match);
      if (idx === -1) continue;
      // Reject ambiguous multi-occurrence (require unique match unless MultiOccurrenceReplacer)
      if (replacer !== MultiOccurrenceReplacer && normalized.lastIndexOf(match) !== idx) continue;
      return normalized.substring(0, idx) + newStr + normalized.substring(idx + match.length);
    }
  }
  return null;
}

// ─── Edit File (Replace) ─────────────────────────────────
export const editFileTool: ToolRegistration = {
  definition: {
    name: 'Edit',
    description:
      'Replace an exact string in a file. Uses 9-strategy fuzzy matching (whitespace, indentation, ' +
      'escape sequences, block anchors) so minor LLM transcription differences are handled gracefully.',
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
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }
      const content = readFileSync(filePath, 'utf-8');
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;

      const result = fuzzyReplace(content, oldStr, newStr);
      if (result !== null) {
        writeFileSync(filePath, result, 'utf-8');
        return `✓ Edit applied to ${filePath}`;
      }

      return (
        `Error: old_string not found in file after trying 9 fuzzy matching strategies.\n` +
        `Make sure the text exists in the file. Tips:\n` +
        `  • Use Read tool first to confirm the exact content\n` +
        `  • Check for leading/trailing whitespace differences\n` +
        `  • For large blocks, include the first and last lines as anchors`
      );
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
        // Match bare shell names (bash, sh, zsh, dash) AND absolute paths (/bin/bash, /usr/bin/bash, etc.)
        { pat: /\|\s*(\/\S+\/)?(ba|z|da)?sh\s*$/,  label: 'pipe to shell (code execution)' },
        { pat: /\|\s*(\/\S+\/)?(ba|z|da)?sh\s+-/,  label: 'pipe to shell (code execution)' },
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

    const startMs = Date.now();
    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const elapsed = Date.now() - startMs;
      const raw = output.trim() || '(no output)';
      // Truncate large bash output to avoid context bloat
      const { content, truncated } = truncateOutput(raw);
      const timingNote = elapsed > 5000 ? `\n(Completed in ${(elapsed / 1000).toFixed(1)}s)` : '';
      return content + (truncated ? timingNote : timingNote);
    } catch (err: unknown) {
      const elapsed = Date.now() - startMs;
      const e = err as { stdout?: string; stderr?: string; message?: string; signal?: string };
      const parts: string[] = [];
      if (e.stdout?.trim()) parts.push(e.stdout.trim());
      if (e.stderr?.trim()) parts.push(e.stderr.trim());
      // Avoid double-printing the message if it's already in stderr
      if (!e.stderr && e.message) parts.push(`Exit error: ${e.message}`);
      // Distinguish timeout from other failures
      if (e.signal === 'SIGTERM' || (e.message?.includes('ETIMEDOUT') ?? false)) {
        parts.push(`(Command timed out after ${timeout}ms — use a higher timeout parameter or split into smaller steps)`);
      }
      const rawErr = parts.join('\n') || 'Command failed';
      const { content } = truncateOutput(rawErr);
      const timingNote = elapsed > 5000 ? `\n(Failed after ${(elapsed / 1000).toFixed(1)}s)` : '';
      return content + timingNote;
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

    const MAX_GREP_RESULTS = 100;
    const MAX_GREP_LINE_LENGTH = 2000;

    try {
      // Escape the pattern for shell — use single quotes to avoid most injection
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'");
      const cmd = [
        'grep', '-rn', caseFlag, includeFlag,
        '--exclude-dir=node_modules', '--exclude-dir=.git',
        '-E', `'${escapedPattern}'`,
        `'${escapedSearchPath}'`,
        '2>/dev/null',
      ].filter(Boolean).join(' ');

      const raw = execSync(cmd, { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }).trim();
      if (!raw) return `No matches found for pattern: ${pattern}`;

      // Parse into structured records
      interface GrepMatch { file: string; line: number; content: string; mtime: number; }
      const rawLines = raw.split('\n');
      const allMatches: GrepMatch[] = [];
      for (const ln of rawLines) {
        if (!ln) continue;
        const m = ln.match(/^(.+?):(\d+):(.*)/);
        if (!m) continue;
        let mtime = 0;
        try { mtime = statSync(m[1]).mtimeMs; } catch { /* ignore */ }
        allMatches.push({ file: m[1], line: parseInt(m[2], 10), content: m[3], mtime });
      }

      const totalMatches = allMatches.length;

      // Apply MMR reranking (reduces per-file redundancy)
      const mmrEnabled = process.env.AGENT_MMR !== '0';
      const grepResults = allMatches.map((r) => ({ file: r.file, line: r.line, content: r.content }));
      const reranked = mmrRerankGrepResults(grepResults, { enabled: mmrEnabled, lambda: 0.7 });

      // Re-attach mtime for sorting; sort by mtime descending (recently-modified files first)
      const withMtime = reranked.map((r) => {
        const orig = allMatches.find((m) => m.file === r.file && m.line === r.line);
        return { ...r, mtime: orig?.mtime ?? 0 };
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const truncated = withMtime.length > MAX_GREP_RESULTS;
      const finalMatches = truncated ? withMtime.slice(0, MAX_GREP_RESULTS) : withMtime;

      // Group by file (inspired by opencode grep.ts)
      const outputLines: string[] = [
        `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'}` +
        (truncated ? ` (showing first ${MAX_GREP_RESULTS})` : ''),
      ];
      let currentFile = '';
      for (const r of finalMatches) {
        if (r.file !== currentFile) {
          if (currentFile) outputLines.push('');
          currentFile = r.file;
          outputLines.push(`${r.file}:`);
        }
        const lineText = r.content.length > MAX_GREP_LINE_LENGTH
          ? r.content.substring(0, MAX_GREP_LINE_LENGTH) + '...'
          : r.content;
        outputLines.push(`  Line ${r.line}: ${lineText}`);
      }
      if (truncated) {
        outputLines.push('');
        outputLines.push(
          `(Results truncated: ${totalMatches - MAX_GREP_RESULTS} hidden. ` +
          `Use a more specific pattern or path to narrow results.)`,
        );
      }
      return outputLines.join('\n');
    } catch {
      return `No matches found for pattern: ${pattern}`;
    }
  },
};
