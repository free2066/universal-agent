/**
 * Error utility — consistent error detail extraction
 *
 * Problem: Multiple catch blocks across the codebase use ad-hoc type assertions
 * to extract messages from unknown errors (CWE-390 style fragility).
 *
 * Solution: One canonical helper that handles all common shapes:
 *   - Error instances (message)
 *   - child_process errors ({ stderr, stdout, message })
 *   - Plain strings
 *   - Unknown objects
 */

/**
 * Extract a human-readable detail string from an unknown error value.
 *
 * Priority order:
 *   1. stderr (child_process errors)
 *   2. Error.message
 *   3. String coercion fallback
 *
 * @param err - Any caught value from a catch block
 * @returns A non-empty string describing the error
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    // Child process errors may carry stderr as a property
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.stderr && typeof e.stderr === 'string' && e.stderr.trim()) {
      return e.stderr.trim();
    }
    return err.message || String(err);
  }

  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.stderr === 'string' && obj.stderr.trim()) return obj.stderr.trim();
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
  }

  return String(err);
}

/**
 * Wrap an unknown catch value in an Error (if it isn't already).
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(errorDetail(err));
}
