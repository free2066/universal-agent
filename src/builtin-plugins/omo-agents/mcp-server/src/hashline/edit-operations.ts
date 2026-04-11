/**
 * Hashline edit operations — core engine for applying LINE#ID-anchored edits
 *
 * Key design principles (ported from oh-my-openagent):
 * 1. All edits are validated (hash check) before any mutation
 * 2. Edits are sorted bottom-to-top to avoid line number shifting
 * 3. Duplicate edits are deduplicated by pos+op
 * 4. Overlapping ranges are detected and rejected
 */

import { parseLineRef } from './validation.js'
import { validateLineRefs } from './validation.js'
import type { HashlineEdit, HashlineApplyReport, ReplaceEdit } from './types.js'

/** Precedence for tie-breaking same-line edits */
const EDIT_PRECEDENCE: Record<string, number> = {
  replace: 0,
  append: 1,
  prepend: 2,
}

/**
 * Get the sort key (line number) for an edit.
 * For range replaces (pos+end), sort by the end line (bottom of range).
 */
function getEditLineNumber(edit: HashlineEdit): number {
  switch (edit.op) {
    case 'replace':
      return parseLineRef((edit as ReplaceEdit).end ?? edit.pos).line
    case 'append':
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY
    case 'prepend':
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY
    default: {
      // P2: exhaustive check — guard against unknown op types at runtime
      const _exhaustive: never = edit
      throw new Error(`[hashline] Unknown edit op: ${(_exhaustive as { op?: string }).op ?? 'unknown'}`)
    }
  }
}

/**
 * Build a deduplication key for an edit.
 * Two edits with the same key are considered duplicates.
 */
function editKey(edit: HashlineEdit): string {
  switch (edit.op) {
    case 'replace':
      return `replace:${edit.pos}${edit.end ? `:${edit.end}` : ''}`
    case 'append':
      return `append:${edit.pos ?? 'eof'}`
    case 'prepend':
      return `prepend:${edit.pos ?? 'bof'}`
  }
}

/**
 * Remove duplicate edits. When duplicates exist, keeps the last occurrence
 * (last wins, consistent with OmO behavior).
 */
function dedupeEdits(edits: HashlineEdit[]): {
  edits: HashlineEdit[]
  deduplicatedEdits: HashlineEdit[]
} {
  const seen = new Map<string, number>()
  const deduplicatedEdits: HashlineEdit[] = []

  // Pass 1: find duplicates
  for (let i = 0; i < edits.length; i++) {
    const key = editKey(edits[i]!)
    if (seen.has(key)) {
      deduplicatedEdits.push(edits[seen.get(key)!]!)
    }
    seen.set(key, i)
  }

  // Pass 2: keep only the last occurrence of each key
  const unique = edits.filter((edit, i) => seen.get(editKey(edit)) === i)
  return { edits: unique, deduplicatedEdits }
}

/**
 * Collect all LINE#ID references from a set of edits (for batch validation).
 */
function collectLineRefs(edits: HashlineEdit[]): string[] {
  const refs: string[] = []
  for (const edit of edits) {
    if (edit.op === 'replace') {
      if (edit.pos) refs.push(edit.pos)
      if (edit.end) refs.push(edit.end)
    } else if (edit.op === 'append' || edit.op === 'prepend') {
      if (edit.pos) refs.push(edit.pos)
    }
  }
  return refs
}

/**
 * Detect overlapping replace ranges.
 * Returns an error message string if overlap detected, null otherwise.
 */
function detectOverlappingRanges(edits: HashlineEdit[]): string | null {
  const ranges: Array<{ start: number; end: number; pos: string }> = []

  for (const edit of edits) {
    if (edit.op === 'replace' && edit.end) {
      const start = parseLineRef(edit.pos).line
      const end = parseLineRef(edit.end).line
      ranges.push({ start, end, pos: edit.pos })
    }
  }

  // Sort by start line and check for overlaps
  ranges.sort((a, b) => a.start - b.start)
  for (let i = 0; i < ranges.length - 1; i++) {
    const curr = ranges[i]!
    const next = ranges[i + 1]!
    if (curr.end >= next.start) {
      return `Overlapping replace ranges detected: "${curr.pos}..${curr.end}" overlaps with "${next.pos}"`
    }
  }

  return null
}

// --------------- Low-level line array mutators ---------------

function applySetLine(lines: string[], lineNumber: number, newLines: string[]): string[] {
  const result = [...lines]
  result.splice(lineNumber - 1, 1, ...newLines)
  return result
}

function applyReplaceRange(
  lines: string[],
  startLine: number,
  endLine: number,
  newLines: string[],
): string[] {
  const result = [...lines]
  result.splice(startLine - 1, endLine - startLine + 1, ...newLines)
  return result
}

function applyInsertAfter(lines: string[], lineNumber: number, newLines: string[]): string[] {
  const result = [...lines]
  result.splice(lineNumber, 0, ...newLines)
  return result
}

function applyInsertBefore(lines: string[], lineNumber: number, newLines: string[]): string[] {
  const result = [...lines]
  result.splice(lineNumber - 1, 0, ...newLines)
  return result
}

function applyAppend(lines: string[], newLines: string[]): string[] {
  return [...lines, ...newLines]
}

function applyPrepend(lines: string[], newLines: string[]): string[] {
  return [...newLines, ...lines]
}

// --------------- Main export ---------------

/**
 * Apply a set of LINE#ID-anchored edits to file content.
 *
 * Process:
 * 1. Deduplicate edits
 * 2. Sort bottom-to-top (prevent line number shifts)
 * 3. Validate all LINE#IDs (throws HashlineMismatchError on mismatch)
 * 4. Detect overlapping ranges
 * 5. Apply edits
 *
 * @param content - Current file content (string)
 * @param edits - Normalized HashlineEdit array
 * @returns HashlineApplyReport with new content and metadata
 */
export function applyHashlineEditsWithReport(
  content: string,
  edits: HashlineEdit[],
): HashlineApplyReport {
  // 1. Deduplicate
  const { edits: dedupedEdits, deduplicatedEdits } = dedupeEdits(edits)

  // 2. Sort bottom-to-top
  const sortedEdits = [...dedupedEdits].sort((a, b) => {
    const lineA = getEditLineNumber(a)
    const lineB = getEditLineNumber(b)
    if (lineB !== lineA) return lineB - lineA
    return (EDIT_PRECEDENCE[a.op] ?? 99) - (EDIT_PRECEDENCE[b.op] ?? 99)
  })

  // 3. Split content into lines (handle empty file)
  let lines = content.length === 0 ? [] : content.split('\n')
  // Remove trailing empty element if file ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1)
  }

  // 4. Batch validate all LINE#IDs
  const refs = collectLineRefs(sortedEdits)
  if (refs.length > 0) {
    validateLineRefs(lines, refs)
  }

  // 5. Detect overlapping ranges
  const overlapError = detectOverlappingRanges(sortedEdits)
  if (overlapError) throw new Error(overlapError)

  // 6. Track no-op edits (lines that already match the new content)
  const noopEdits: HashlineEdit[] = []

  // 7. Apply edits
  for (const edit of sortedEdits) {
    switch (edit.op) {
      case 'replace': {
        const newLines = normalizeToArray(edit.lines)
        const startLine = parseLineRef(edit.pos).line
        if (edit.end) {
          const endLine = parseLineRef(edit.end).line
          // Guard: end must be >= start; reject inverted ranges to prevent silent inserts
          if (endLine < startLine) {
            throw new Error(
              `replace edit: end "${edit.end}" (line ${endLine}) must be >= pos "${edit.pos}" (line ${startLine})`,
            )
          }
          // Check noop: range matches newLines exactly
          const existing = lines.slice(startLine - 1, endLine)
          if (arraysEqual(existing, newLines)) {
            noopEdits.push(edit)
          } else {
            lines = applyReplaceRange(lines, startLine, endLine, newLines)
          }
        } else {
          const existing = [lines[startLine - 1] ?? '']
          if (arraysEqual(existing, newLines)) {
            noopEdits.push(edit)
          } else {
            lines = applySetLine(lines, startLine, newLines)
          }
        }
        break
      }
      case 'append': {
        const newLines = normalizeToArray(edit.lines)
        if (edit.pos) {
          const lineNum = parseLineRef(edit.pos).line
          lines = applyInsertAfter(lines, lineNum, newLines)
        } else {
          lines = applyAppend(lines, newLines)
        }
        break
      }
      case 'prepend': {
        const newLines = normalizeToArray(edit.lines)
        if (edit.pos) {
          const lineNum = parseLineRef(edit.pos).line
          lines = applyInsertBefore(lines, lineNum, newLines)
        } else {
          lines = applyPrepend(lines, newLines)
        }
        break
      }
    }
  }

  return {
    content: lines.join('\n') + (content.endsWith('\n') ? '\n' : ''),
    noopEdits,
    deduplicatedEdits,
  }
}

// --------------- Utilities ---------------

function normalizeToArray(lines: string | string[] | null): string[] {
  if (lines === null || lines === undefined) return []
  if (typeof lines === 'string') return [lines]
  return lines
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}
