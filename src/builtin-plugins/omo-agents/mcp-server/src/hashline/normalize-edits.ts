/**
 * Hashline normalize-edits — normalizes raw LLM output to typed HashlineEdit objects
 */

import type { RawHashlineEdit, HashlineEdit, ReplaceEdit, AppendEdit, PrependEdit } from './types.js'

/**
 * Normalize a raw edit (as received from the MCP tool call) to a typed HashlineEdit.
 * - Validates the `op` field
 * - Coerces `lines: null` to `[]` for replace (= delete)
 * - Coerces string lines to array
 */
export function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
  return rawEdits.map((raw, index) => {
    if (!raw.op) {
      throw new Error(`Edit at index ${index} is missing required field "op" (replace|append|prepend)`)
    }
    switch (raw.op) {
      case 'replace':
        return normalizeReplaceEdit(raw, index)
      case 'append':
        return normalizeAppendEdit(raw, index)
      case 'prepend':
        return normalizePrependEdit(raw, index)
      default:
        throw new Error(`Edit at index ${index} has unknown op "${raw.op}". Must be replace|append|prepend`)
    }
  })
}

function normalizeReplaceEdit(raw: RawHashlineEdit, index: number): ReplaceEdit {
  if (!raw.pos) {
    throw new Error(`replace edit at index ${index} requires "pos" (LINE#ID of line to replace)`)
  }
  const lines = normalizeLines(raw.lines, index)
  return {
    op: 'replace',
    pos: raw.pos,
    ...(raw.end ? { end: raw.end } : {}),
    lines,
  }
}

function normalizeAppendEdit(raw: RawHashlineEdit, index: number): AppendEdit {
  const lines = normalizeLines(raw.lines, index)
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`append edit at index ${index} requires non-empty "lines"`)
  }
  return {
    op: 'append',
    ...(raw.pos ? { pos: raw.pos } : {}),
    lines,
  }
}

function normalizePrependEdit(raw: RawHashlineEdit, index: number): PrependEdit {
  const lines = normalizeLines(raw.lines, index)
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`prepend edit at index ${index} requires non-empty "lines"`)
  }
  return {
    op: 'prepend',
    ...(raw.pos ? { pos: raw.pos } : {}),
    lines,
  }
}

/**
 * Normalize the `lines` field:
 * - null → [] (delete)
 * - string → [string]
 * - string[] → string[]
 */
function normalizeLines(
  lines: string | string[] | null | undefined,
  index: number,
): string[] | null {
  if (lines === null || lines === undefined) return null
  if (typeof lines === 'string') return [lines]
  if (Array.isArray(lines)) return lines
  throw new Error(`Edit at index ${index}: "lines" must be a string, array of strings, or null`)
}
