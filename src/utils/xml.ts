// ============================================================================
// XML escape utilities with precompiled regex (performance optimized)
// ============================================================================

/** Precompiled regex for XML text content escaping */
const XML_TEXT_ESCAPE_REGEX = /[&<>]/g

/** Precompiled regex for XML attribute escaping */
const XML_ATTR_ESCAPE_REGEX = /[&<>"']/g

/** Character to entity mapping for XML escaping */
const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * Escape XML/HTML special characters for safe interpolation into element
 * text content (between tags). Use when untrusted strings (process stdout,
 * user input, external data) go inside `<tag>${here}</tag>`.
 */
export function escapeXml(s: string): string {
  return s.replace(XML_TEXT_ESCAPE_REGEX, char => XML_ESCAPE_MAP[char] || char)
}

/**
 * Escape for interpolation into a double- or single-quoted attribute value:
 * `<tag attr="${here}">`. Escapes quotes in addition to `& < >`.
 */
export function escapeXmlAttr(s: string): string {
  return s.replace(XML_ATTR_ESCAPE_REGEX, char => XML_ESCAPE_MAP[char] || char)
}
