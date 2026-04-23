/**
 * Shared path-related constants and utilities.
 * Centralizes commonly used regex patterns to avoid duplication across files.
 */

/** Regex to match Windows backslash path separators (precompiled for performance) */
export const WIN_SEP_RE = /\\/g

/** Regex to match forward slash path separators */
export const FORWARD_SEP_RE = /\//g

/** Regex to match newline characters */
export const NEWLINE_RE = /\n/g

/** Regex to match double quote characters */
export const DOUBLE_QUOTE_RE = /"/g

/** Regex to match whitespace (one or more spaces/tabs/etc.) */
export const WHITESPACE_RE = /\s+/g