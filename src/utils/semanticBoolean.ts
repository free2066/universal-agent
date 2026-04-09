import { z } from 'zod/v4'

/**
 * Boolean that also accepts common string/number representations of booleans.
 *
 * Tool inputs arrive as model-generated JSON. Third-party models (e.g.
 * MiMo-V2-Pro, GLM) occasionally quote booleans or use non-standard variants:
 *   - `"replace_all":"true"`  — lowercase string (most common)
 *   - `"replace_all":"True"`  — Python-style capitalised
 *   - `"replace_all":"1"`     — numeric string
 *   - `"replace_all":1`       — bare integer
 *   - `"replace_all":"yes"`   — natural-language affirmative
 *
 * z.coerce.boolean() is the wrong fix: it uses JS truthiness, so "false" → true.
 *
 * z.preprocess emits {"type":"boolean"} to the API schema, so the model is
 * still told this is a boolean — the string/number tolerance is invisible
 * client-side coercion, not an advertised input shape.
 *
 * .optional()/.default() go INSIDE (on the inner schema), not chained after:
 * chaining them onto ZodPipe widens z.output<> to unknown in Zod v4.
 *
 *   semanticBoolean()                              → boolean
 *   semanticBoolean(z.boolean().optional())        → boolean | undefined
 *   semanticBoolean(z.boolean().default(false))    → boolean
 */

const TRUTHY_STRINGS = new Set(['true', '1', 'yes', 'on'])
const FALSY_STRINGS = new Set(['false', '0', 'no', 'off'])

function coerceToBooleanLike(v: unknown): unknown {
  if (typeof v === 'string') {
    const lower = v.toLowerCase()
    if (TRUTHY_STRINGS.has(lower)) return true
    if (FALSY_STRINGS.has(lower)) return false
  }
  if (typeof v === 'number') {
    if (v === 1) return true
    if (v === 0) return false
  }
  return v
}

export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(coerceToBooleanLike, inner)
}
