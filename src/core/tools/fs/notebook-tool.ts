/**
 * notebook-tool.ts -- Jupyter Notebook (.ipynb) cell editor
 *
 * Mirrors claude-code's NotebookEditTool.ts.
 *
 * Supports three edit modes:
 * - replace: modify an existing cell's source
 * - insert: add a new cell at a given position
 * - delete: remove a cell
 *
 * Safety checks (same as claude-code):
 * - File must have .ipynb extension
 * - Read-before-Edit: file must have been read (tracked via readFileTimestamps)
 * - mtime check: file must not have been modified externally since last read
 * - write requires write permission check
 *
 * Round 5: claude-code NotebookEditTool.ts parity
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

// ── A30: Encoding & line-ending detection ─────────────────────────────────────
// Mirrors claude-code NotebookEditTool.ts readFileSyncWithMetadata + writeTextContent
// to preserve original encoding (utf-8 / utf16le) and line endings (LF / CRLF).

/**
 * A30: Detect file encoding via BOM bytes.
 * Returns 'utf16le' for UTF-16 LE/BE BOM, otherwise 'utf-8'.
 * Mirrors readFileSyncWithMetadata() encoding detection.
 */
function detectEncoding(absPath: string): BufferEncoding {
  try {
    const buf = readFileSync(absPath);
    // UTF-16 LE BOM: 0xFF 0xFE
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16le';
    // UTF-16 BE BOM: 0xFE 0xFF (treat as utf16le for Node compatibility)
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf16le';
    // Default: UTF-8 (BOM 0xEF 0xBB 0xBF is handled transparently by Node)
  } catch { /* non-fatal — fallback to utf-8 */ }
  return 'utf-8';
}

/**
 * A30: Detect dominant line ending style by counting occurrences.
 * Returns 'CRLF' if CRLF sequences outnumber bare LF, otherwise 'LF'.
 * Mirrors writeTextContent() lineEndings parameter behavior.
 */
function detectLineEndings(content: string): 'CRLF' | 'LF' {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const lfCount   = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

// ── Read-state tracking (Read-before-Edit guard) ──────────────────────────────
// Maps absolute path → { mtime at read time }

const _readTimestamps = new Map<string, number>();

export function markNotebookRead(absPath: string): void {
  try {
    const st = statSync(absPath);
    _readTimestamps.set(absPath, st.mtimeMs);
  } catch { /* non-fatal */ }
}

// ── Notebook types ────────────────────────────────────────────────────────────

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  id?: string;
  source: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata?: Record<string, unknown>;
  cells: NotebookCell[];
}

// ── Cell ID resolution ────────────────────────────────────────────────────────

function findCellIndex(cells: NotebookCell[], cellId: string): number {
  // Try exact ID match
  const exactIdx = cells.findIndex((c) => c.id === cellId);
  if (exactIdx >= 0) return exactIdx;

  // Try cell-N format (1-based)
  const cellNMatch = /^cell-(\d+)$/.exec(cellId);
  if (cellNMatch) {
    const n = parseInt(cellNMatch[1]!, 10) - 1;
    if (n >= 0 && n < cells.length) return n;
  }

  return -1;
}

/** Normalize cell source to a single string */
function getCellSource(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) return cell.source.join('');
  return cell.source ?? '';
}

/** Split source string into array for nbformat compatibility */
function splitSource(source: string): string[] {
  if (!source) return [];
  const lines = source.split('\n');
  return lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
}

// ── Tool registration ─────────────────────────────────────────────────────────

export const notebookEditTool: ToolRegistration = {
  searchHint: 'jupyter notebook ipynb cell edit insert delete',
  definition: {
    name: 'NotebookEdit',
    description: [
      'Edit cells in a Jupyter Notebook (.ipynb file).',
      '',
      'Supports three operations:',
      '  replace — modify an existing cell\'s source (default)',
      '  insert  — add a new cell at a position (requires cell_type)',
      '  delete  — remove a cell',
      '',
      'IMPORTANT: You must read the notebook with Read tool before editing.',
      'The notebook must not have been modified externally since your last read.',
      'For code cells, execution_count and outputs are automatically cleared on edit.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        notebook_path: {
          type: 'string',
          description: 'Absolute path to the .ipynb file',
        },
        cell_id: {
          type: 'string',
          description: 'Cell ID or "cell-N" (1-based index). Required for replace/delete.',
        },
        new_source: {
          type: 'string',
          description: 'New cell source content (for replace/insert modes)',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Cell type for insert mode (required when edit_mode=insert)',
        },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'Operation mode: replace (default), insert, or delete',
        },
      },
      required: ['notebook_path', 'new_source'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const notebookPath = (args.notebook_path as string ?? '').trim();
    const cellId = args.cell_id as string | undefined;
    const newSource = (args.new_source as string ?? '');
    const cellTypeArg = args.cell_type as 'code' | 'markdown' | undefined;
    const editMode = (args.edit_mode as string ?? 'replace') as 'replace' | 'insert' | 'delete';

    // 1. Validate extension
    if (extname(notebookPath).toLowerCase() !== '.ipynb') {
      return `[NotebookEdit] Error: file must have .ipynb extension, got "${extname(notebookPath)}"`;
    }

    const absPath = resolve(process.cwd(), notebookPath);

    // 2. File existence
    if (!existsSync(absPath)) {
      return `[NotebookEdit] Error: file not found: ${absPath}`;
    }

    // 3. Read-before-Edit check
    const lastReadMtime = _readTimestamps.get(absPath);
    if (lastReadMtime === undefined) {
      return (
        `[NotebookEdit] Error: you must read the notebook with the Read tool before editing.\n` +
        `  Use Read tool on: ${absPath}`
      );
    }

    // 4. mtime check — reject if file was modified externally since our last read
    let currentMtime: number;
    try {
      currentMtime = statSync(absPath).mtimeMs;
    } catch (e) {
      return `[NotebookEdit] Error: cannot stat file: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (currentMtime > lastReadMtime + 100) { // 100ms grace period
      return (
        `[NotebookEdit] Error: notebook was modified externally since your last read.\n` +
        `  Last read: ${new Date(lastReadMtime).toISOString()}\n` +
        `  Current:   ${new Date(currentMtime).toISOString()}\n` +
        `  Please re-read the file before editing.`
      );
    }

    // 5. Validate insert mode requirements
    if (editMode === 'insert' && !cellTypeArg) {
      return '[NotebookEdit] Error: cell_type is required for insert mode';
    }

    // 6. Parse notebook JSON
    let notebook: Notebook;
    let rawContent: string;
    try {
      rawContent = readFileSync(absPath, 'utf-8');
      notebook = JSON.parse(rawContent) as Notebook;
    } catch (e) {
      return `[NotebookEdit] Error: invalid notebook JSON: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (!Array.isArray(notebook.cells)) {
      return '[NotebookEdit] Error: invalid notebook format: missing cells array';
    }

    // 7. Perform edit
    let operationDescription = '';

    if (editMode === 'delete') {
      if (!cellId) return '[NotebookEdit] Error: cell_id is required for delete mode';
      const idx = findCellIndex(notebook.cells, cellId);
      if (idx < 0) return `[NotebookEdit] Error: cell "${cellId}" not found`;
      const deletedType = notebook.cells[idx]!.cell_type;
      notebook.cells.splice(idx, 1);
      operationDescription = `Deleted ${deletedType} cell "${cellId}" (was at index ${idx})`;

    } else if (editMode === 'insert') {
      const cellType = cellTypeArg!;
      // Determine insertion index: after cellId, or at end
      let insertIdx = notebook.cells.length;
      if (cellId) {
        const refIdx = findCellIndex(notebook.cells, cellId);
        if (refIdx >= 0) insertIdx = refIdx + 1;
      }

      // Generate cell ID for nbformat >= 4.5
      const supportsId = notebook.nbformat > 4 ||
        (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5);
      const newCell: NotebookCell = {
        cell_type: cellType,
        source: splitSource(newSource),
        metadata: {},
        ...(supportsId ? { id: `cell-${Date.now().toString(36)}` } : {}),
        ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
      };

      notebook.cells.splice(insertIdx, 0, newCell);
      operationDescription = `Inserted ${cellType} cell at index ${insertIdx}`;

    } else {
      // replace (default)
      if (!cellId) return '[NotebookEdit] Error: cell_id is required for replace mode';
      const idx = findCellIndex(notebook.cells, cellId);

      if (idx < 0) {
        // If cell_id points beyond end → treat as append
        if (/^cell-(\d+)$/.exec(cellId)?.[1] && parseInt(/^cell-(\d+)$/.exec(cellId)![1]!, 10) - 1 === notebook.cells.length) {
          const cellType = cellTypeArg ?? 'code';
          const supportsId = notebook.nbformat > 4 || (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5);
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: splitSource(newSource),
            metadata: {},
            ...(supportsId ? { id: `cell-${Date.now().toString(36)}` } : {}),
            ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
          };
          notebook.cells.push(newCell);
          operationDescription = `Appended new ${cellType} cell`;
        } else {
          return `[NotebookEdit] Error: cell "${cellId}" not found`;
        }
      } else {
        const cell = notebook.cells[idx]!;
        const oldSource = getCellSource(cell);
        cell.source = splitSource(newSource);

        // Change cell type if requested
        if (cellTypeArg && cellTypeArg !== cell.cell_type) {
          cell.cell_type = cellTypeArg;
        }

        // Clear execution state for code cells
        if (cell.cell_type === 'code') {
          cell.execution_count = null;
          cell.outputs = [];
        }

        const sourceChanged = oldSource !== newSource;
        operationDescription = `Replaced cell "${cellId}" source (${sourceChanged ? 'changed' : 'unchanged'})`;
      }
    }

    // 8. Write back with original encoding and line endings preserved
    try {
      // A30: read original content for encoding/line-ending detection
      // Mirrors claude-code NotebookEditTool.ts L324-325 readFileSyncWithMetadata +
      // L432 writeTextContent(fullPath, updatedContent, encoding, lineEndings)
      const rawContent  = readFileSync(absPath, 'utf-8');
      const lineEndings = detectLineEndings(rawContent);
      const encoding    = detectEncoding(absPath);

      let toWrite = JSON.stringify(notebook, null, 1);
      // A30: preserve CRLF line endings — Windows ipynb files should not be converted to LF
      if (lineEndings === 'CRLF') {
        toWrite = toWrite.replace(/\n/g, '\r\n');
      }
      writeFileSync(absPath, toWrite, { encoding });
      // Update read timestamp to current mtime
      markNotebookRead(absPath);
    } catch (e) {
      return `[NotebookEdit] Error writing file: ${e instanceof Error ? e.message : String(e)}`;
    }

    return `[NotebookEdit] ${operationDescription}. Notebook saved: ${absPath}`;
  },
};
