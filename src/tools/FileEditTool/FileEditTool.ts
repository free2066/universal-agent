/**
 * FileEditTool/FileEditTool.ts — Replace exact string in a file
 *
 * Mirrors claude-code's FileEditTool.ts.
 * Uses 9-strategy fuzzy matching for robustness.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import type { ToolRegistration } from '../../models/types.js';
import { safeResolvePath, quickCompileCheck } from '../shared/fsHelpers.js';
import { fireFileChanged } from '../../core/hooks.js';

// ─── Edit File Fuzzy Replacers ────────────────────────────────────────────────
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

function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const normOld = oldStr.replace(/\r\n/g, '\n');

  for (const replacer of [
    SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer,
    WhitespaceNormalizedReplacer, IndentationFlexibleReplacer,
    EscapeNormalizedReplacer, TrimmedBoundaryReplacer,
    ContextAwareReplacer, MultiOccurrenceReplacer,
  ]) {
    for (const match of replacer(normalized, normOld)) {
      const idx = normalized.indexOf(match);
      if (idx === -1) continue;
      if (replacer !== MultiOccurrenceReplacer && normalized.lastIndexOf(match) !== idx) continue;
      return normalized.substring(0, idx) + newStr + normalized.substring(idx + match.length);
    }
  }
  return null;
}

export const editFileTool: ToolRegistration = {
  definition: {
    name: 'Edit',
    description:
      'Replace an exact string in a file. Uses 9-strategy fuzzy matching (whitespace, indentation, ' +
      'escape sequences, block anchors) so minor LLM transcription differences are handled gracefully. ' +
      'Set replace_all=true to replace ALL occurrences of old_string.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to edit' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Text to replace it with' },
        replace_all: {
          type: 'boolean',
          description: 'Replace ALL occurrences of old_string (default false).',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  backfillObservableInput(input) {
    if (typeof input['file_path'] === 'string' && !input['file_path'].startsWith('/')) {
      input['file_path'] = resolve(process.cwd(), input['file_path']);
    }
  },
  handler: async (args) => {
    let filePath: string;
    try {
      filePath = safeResolvePath(args.file_path as string, process.cwd());
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    try {
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }
      const content = readFileSync(filePath, 'utf-8');
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      const replaceAll = !!(args.replace_all as boolean | undefined);

      if (replaceAll) {
        const normalized = content.replace(/\r\n/g, '\n');
        const normOld = oldStr.replace(/\r\n/g, '\n');
        const occurrences = normalized.split(normOld).length - 1;
        if (occurrences === 0) {
          return `Error: old_string not found in file (replace_all=true).\nMake sure the text exists in the file.`;
        }
        const replaced = normalized.split(normOld).join(newStr);
        writeFileSync(filePath, replaced, 'utf-8');
        setImmediate(() => { try { fireFileChanged(filePath); } catch { /* non-fatal */ } });
        const oldLines = content.split('\n').length;
        const newLines = replaced.split('\n').length;
        const addedLines = Math.max(0, newLines - oldLines);
        const removedLines = Math.max(0, oldLines - newLines);
        const changedChars = Math.abs(replaced.length - content.length);
        const diffSummary = (addedLines === 0 && removedLines === 0)
          ? `${changedChars} chars changed`
          : `+${addedLines} -${removedLines} lines, ${changedChars} chars`;
        return `✓ Edit applied to ${filePath} (${occurrences} occurrence${occurrences !== 1 ? 's' : ''}, ${diffSummary})`;
      }

      const normalized = content.replace(/\r\n/g, '\n');
      const normOld = oldStr.replace(/\r\n/g, '\n');
      if (normOld.length > 0) {
        const occurrences = normalized.split(normOld).length - 1;
        if (occurrences > 1) {
          return (
            `Error: Found ${occurrences} occurrences of old_string in the file, but replace_all is false.\n` +
            `To replace all occurrences, set replace_all=true.\n` +
            `To replace a specific occurrence, include more surrounding context in old_string to make it unique.`
          );
        }
      }

      const result = fuzzyReplace(content, oldStr, newStr);
      if (result !== null) {
        writeFileSync(filePath, result, 'utf-8');
        setImmediate(() => { try { fireFileChanged(filePath); } catch { /* non-fatal */ } });
        const oldLines = content.split('\n').length;
        const newLines = result.split('\n').length;
        const addedLines = Math.max(0, newLines - oldLines);
        const removedLines = Math.max(0, oldLines - newLines);
        const changedChars = Math.abs(result.length - content.length);
        const diffSummary = (addedLines === 0 && removedLines === 0)
          ? `${changedChars} chars changed`
          : `+${addedLines} -${removedLines} lines, ${changedChars} chars`;
        const fileExt = extname(filePath).toLowerCase();
        let compileNote = '';
        if (['.ts', '.tsx', '.java'].includes(fileExt)) {
          try {
            const checkResult = quickCompileCheck(filePath, fileExt);
            if (checkResult) compileNote = `\n  ${checkResult}`;
          } catch { /* non-fatal */ }
        }
        return `✓ Edit applied to ${filePath}\n  (${diffSummary})${compileNote}`;
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
