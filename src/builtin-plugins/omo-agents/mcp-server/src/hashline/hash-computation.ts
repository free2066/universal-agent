/**
 * Hashline hash computation — ported from oh-my-openagent (OmO)
 *
 * OmO uses Bun.hash.xxHash32 which is not available in Node.js.
 * This module implements a compatible xxHash32 using pure JavaScript.
 * The output is used only as an index mod 256 into HASHLINE_DICT,
 * so exact xxHash32 byte-for-byte compatibility is NOT required —
 * what matters is internal consistency (same input → same hash).
 */

import { HASHLINE_DICT } from './constants.js'

const RE_SIGNIFICANT = /[a-zA-Z0-9]/

/**
 * Lightweight xxHash32-like hash function.
 * Only guarantees: deterministic within a process, uniform distribution.
 * NOT bit-compatible with the C xxHash32 algorithm.
 *
 * Note: OmO uses Bun.hash.xxHash32 which is the real xxHash32.
 * Files hashed with OmO will have different LINE#IDs than this implementation.
 * This is intentional — omo-agents is a standalone tool with its own consistent hashing.
 */
function xxHash32Like(str: string, seed: number): number {
  // FNV-1a inspired mix with seed support — fast and well-distributed
  let hash = (seed ^ 0x165667b1) >>> 0
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x9e3779b9) >>> 0
    hash ^= hash >>> 16
    hash = Math.imul(hash, 0x85ebca6b) >>> 0
    hash ^= hash >>> 13
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0
    hash ^= hash >>> 16
  }
  return hash >>> 0
}

/**
 * Compute the 2-char hash ID for a line.
 *
 * Algorithm:
 * 1. Normalize: strip \r and trailing whitespace
 * 2. Seed selection: 0 for lines with alphanumeric chars, lineNumber otherwise
 *    (so blank/symbol-only lines are distinguished by position)
 * 3. Hash: xxHash32Like(normalized, seed) % 256 → HASHLINE_DICT[result]
 */
export function computeLineHash(lineNumber: number, content: string): string {
  const stripped = content.replace(/\r/g, '').trimEnd()
  const seed = RE_SIGNIFICANT.test(stripped) ? 0 : lineNumber
  const hash = xxHash32Like(stripped, seed)
  return HASHLINE_DICT[hash % 256]!
}

/**
 * Format a line as "lineNumber#hashID|content"
 * This is the format used by hashline_read output.
 */
export function formatHashLine(lineNumber: number, content: string): string {
  const hash = computeLineHash(lineNumber, content)
  return `${lineNumber}#${hash}|${content}`
}
