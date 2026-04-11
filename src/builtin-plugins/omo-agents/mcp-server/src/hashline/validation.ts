/**
 * Hashline validation — ported from oh-my-openagent (OmO)
 *
 * Validates LINE#ID references against actual file content.
 * When a hash mismatch is detected, the error message includes
 * the correct LINE#ID so the LLM can retry without confusion.
 */

import { computeLineHash } from './hash-computation.js'
import { HASHLINE_REF_PATTERN } from './constants.js'
import type { LineRef } from './types.js'

/**
 * Parse a LINE#ID string (e.g. "11#XJ") into a LineRef.
 * Throws if the format is invalid.
 */
export function parseLineRef(ref: string): LineRef {
  const match = HASHLINE_REF_PATTERN.exec(ref)
  if (!match) {
    throw new Error(
      `Invalid LINE#ID format: "${ref}". Expected format: "lineNumber#XX" where XX is two chars from ZPMQVRWSNKTXJBYH`,
    )
  }
  return {
    line: parseInt(match[1]!, 10),
    hash: match[2]!,
  }
}

/**
 * Custom error for hash mismatches.
 * Includes enough context for the LLM to identify the correct anchor.
 */
export class HashlineMismatchError extends Error {
  constructor(
    public readonly mismatches: Array<{ line: number; expected: string }>,
    lines: string[],
  ) {
    const messages = mismatches.map(({ line, expected }) => {
      const actual = lines[line - 1]
      const correctHash = actual !== undefined ? computeLineHash(line, actual) : '??'
      const context = buildContext(lines, line)
      return [
        `Line ${line}: hash mismatch.`,
        `  You provided hash: "${expected}", correct hash: "${line}#${correctHash}"`,
        `  Context (±2 lines):`,
        context,
      ].join('\n')
    })
    super(
      `Hash-anchored edit failed — LINE#ID mismatch(es):\n\n${messages.join('\n\n')}\n\n` +
        `The file has likely changed since you last read it. ` +
        `Use hashline_read to get fresh LINE#IDs, then retry your edits.`,
    )
    this.name = 'HashlineMismatchError'
  }
}

/**
 * Build a context snippet showing ±2 lines around the target line.
 */
function buildContext(lines: string[], lineNumber: number): string {
  const start = Math.max(1, lineNumber - 2)
  const end = Math.min(lines.length, lineNumber + 2)
  const result: string[] = []
  for (let i = start; i <= end; i++) {
    const content = lines[i - 1]!
    const hash = computeLineHash(i, content)
    const marker = i === lineNumber ? '>>> ' : '    '
    result.push(`  ${marker}${i}#${hash}|${content}`)
  }
  return result.join('\n')
}

/**
 * Validate a single LINE#ID reference against the file's current content.
 * Throws HashlineMismatchError if the hash does not match.
 */
export function validateLineRef(lines: string[], ref: string): void {
  const { line, hash } = parseLineRef(ref)
  if (line < 1 || line > lines.length) {
    throw new Error(
      `LINE#ID "${ref}" refers to line ${line}, but the file only has ${lines.length} lines.`,
    )
  }
  const content = lines[line - 1]!
  const correctHash = computeLineHash(line, content)
  if (correctHash !== hash) {
    throw new HashlineMismatchError([{ line, expected: hash }], lines)
  }
}

/**
 * Validate multiple LINE#ID references in a single pass.
 * Collects all mismatches and throws a single combined error.
 */
export function validateLineRefs(lines: string[], refs: string[]): void {
  const mismatches: Array<{ line: number; expected: string }> = []

  for (const ref of refs) {
    if (!ref) continue
    let parsed: LineRef
    try {
      parsed = parseLineRef(ref)
    } catch (err) {
      // Re-throw parse errors immediately — preserve original message for better LLM debugging
      throw new Error(`Invalid LINE#ID "${ref}": ${(err as Error).message}`)
    }

    const { line, hash } = parsed
    if (line < 1 || line > lines.length) {
      throw new Error(
        `LINE#ID "${ref}" refers to line ${line}, but the file only has ${lines.length} lines.`,
      )
    }
    const content = lines[line - 1]!
    const correctHash = computeLineHash(line, content)
    if (correctHash !== hash) {
      mismatches.push({ line, expected: hash })
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, lines)
  }
}
