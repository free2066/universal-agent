/**
 * Safe JSON parsing utilities.
 *
 * Centralises the try/catch + runtime type guard pattern that was previously
 * duplicated ~68 times across the codebase.  Import these instead of writing
 * `try { return JSON.parse(raw) as T; } catch { return fallback; }` inline.
 */

// ─── safeJsonParse ───────────────────────────────────────────────────────────

/**
 * Parse `raw` as JSON and return the result cast to `T`.
 * Returns `fallback` (default `null`) if parsing fails or the result does not
 * satisfy the optional `guard` predicate.
 *
 * @example
 *   const cfg = safeJsonParse<Config>(text, null, (v) => typeof v === 'object' && v !== null);
 *   const arr = safeJsonParse<string[]>(text, [], Array.isArray);
 */
export function safeJsonParse<T>(
  raw: string,
  fallback: T,
  guard?: (value: unknown) => boolean,
): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (guard && !guard(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

// ─── safeJsonParseObject ─────────────────────────────────────────────────────

/**
 * Parse `raw` as JSON and return it only if the result is a plain (non-array)
 * object.  Returns `fallback` otherwise.
 *
 * Useful for config files / JSON records where an array or primitive would be
 * structurally invalid.
 *
 * @example
 *   const cfg = safeJsonParseObject<HooksConfig>(text, { hooks: [] });
 */
export function safeJsonParseObject<T extends object>(
  raw: string,
  fallback: T,
): T {
  return safeJsonParse<T>(raw, fallback, (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

// ─── safeJsonParseArray ──────────────────────────────────────────────────────

/**
 * Parse `raw` as JSON and return it only if the result is an array.
 * Returns `fallback` (default `[]`) otherwise.
 */
export function safeJsonParseArray<T>(raw: string, fallback: T[] = []): T[] {
  return safeJsonParse<T[]>(raw, fallback, Array.isArray);
}
