/**
 * Hashline types — ported from oh-my-openagent (OmO)
 */

/**
 * A replace edit: replaces line(s) at pos (optionally through end) with new lines.
 * - pos: LINE#ID of the line to replace (required)
 * - end: LINE#ID of the last line in range (optional; if omitted, replaces only pos)
 * - lines: replacement content. null/empty array = delete the line(s)
 */
export interface ReplaceEdit {
  op: 'replace'
  pos: string
  end?: string
  lines: string | string[] | null
}

/**
 * An append edit: inserts lines AFTER pos (or at end-of-file if pos is omitted).
 */
export interface AppendEdit {
  op: 'append'
  pos?: string
  lines: string | string[]
}

/**
 * A prepend edit: inserts lines BEFORE pos (or at beginning-of-file if pos is omitted).
 */
export interface PrependEdit {
  op: 'prepend'
  pos?: string
  lines: string | string[]
}

export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit

/** Raw (un-normalized) edit as received from the LLM / MCP tool call */
export interface RawHashlineEdit {
  op?: 'replace' | 'append' | 'prepend'
  pos?: string
  end?: string
  lines?: string | string[] | null
}

/** Result of applying a set of edits */
export interface HashlineApplyReport {
  content: string
  noopEdits: HashlineEdit[]
  deduplicatedEdits: HashlineEdit[]
}

/** Parsed line reference from a LINE#ID string */
export interface LineRef {
  line: number
  hash: string
}
