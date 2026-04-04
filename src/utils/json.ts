/**
 * Safe JSON parsing and serialisation utilities.
 *
 * Centralises the try/catch + runtime type guard pattern that was previously
 * duplicated ~68 times across the codebase.
 *
 * Parse side:  safeJsonParse / safeJsonParseObject / safeJsonParseArray
 * Stringify side: safeJsonStringify / compactJsonStringify
 */

import { inspect } from 'node:util';

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

// ─── safeJsonStringify ────────────────────────────────────────────────────────

/**
 * Serialise `value` to a JSON string, handling circular references and
 * non-serialisable values (functions, Buffers, Symbols) gracefully.
 *
 * Falls back to `util.inspect` for values that `JSON.stringify` cannot handle,
 * which means the output may not be valid JSON — but it will never throw.
 *
 * @param value   - Any value to serialise
 * @param indent  - Optional indent (for human-readable output); omit for compact
 * @returns       JSON string, or inspect fallback string on failure
 *
 * @example
 *   const json = safeJsonStringify(myObject);              // compact
 *   const pretty = safeJsonStringify(myObject, 2);         // pretty-printed
 *   const cfg = safeJsonStringify(config, 2);              // config files
 */
export function safeJsonStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    // Circular reference or non-serialisable value (e.g. BigInt, Function).
    // util.inspect handles circular refs with [Circular *1] notation.
    return inspect(value, { depth: 6, breakLength: Infinity });
  }
}

// ─── compactJsonStringify ─────────────────────────────────────────────────────

/**
 * Serialise `value` to a compact (no-whitespace) JSON string.
 * Use this for LLM context injection, network payloads, and log fields where
 * human readability is not required — saves tokens / bytes vs. pretty-print.
 *
 * Unlike `JSON.stringify(value)`, this never throws on circular references.
 *
 * @example
 *   // Inject tool results into LLM context without wasting tokens
 *   const resultStr = typeof result === 'string' ? result : compactJsonStringify(result);
 */
export function compactJsonStringify(value: unknown): string {
  return safeJsonStringify(value, undefined);
}
