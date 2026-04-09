/**
 * Hashline constants — ported from oh-my-openagent (OmO)
 *
 * LINE#ID format: {lineNumber}#{2-char-hash}
 * Example: 11#XJ
 *
 * The 2-char hash is built from NIBBLE_STR using xxHash32 mod 256.
 */

/** 16-character alphabet used to build 2-char hash IDs */
export const NIBBLE_STR = 'ZPMQVRWSNKTXJBYH'

/**
 * Lookup table: 256 entries, each a 2-char combination from NIBBLE_STR.
 * Index = xxHash32(normalizedContent, seed) % 256
 */
export const HASHLINE_DICT: string[] = Array.from({ length: 256 }, (_, i) => {
  const high = i >>> 4
  const low = i & 0x0f
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`
})

/** Matches a LINE#ID reference like "11#XJ" */
export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/

/** Matches an output line like "11#XJ|  console.log('hi');" */
export const HASHLINE_OUTPUT_PATTERN =
  /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/
