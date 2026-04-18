/**
 * Time duration constants in milliseconds
 * Use these instead of magic numbers for better readability and maintainability
 */

/** Milliseconds per second */
export const MS_PER_SECOND = 1000

/** Milliseconds per minute */
export const MS_PER_MINUTE = 60 * MS_PER_SECOND

/** Milliseconds per hour */
export const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** Milliseconds per day */
export const MS_PER_DAY = 24 * MS_PER_HOUR

// ============================================================================
// Common TTLs and timeouts
// ============================================================================

/** Common short cache TTL: 5 minutes */
export const TTL_5_MINUTES_MS = 5 * MS_PER_MINUTE

/** Common cache TTL: 15 minutes */
export const TTL_15_MINUTES_MS = 15 * MS_PER_MINUTE

/** Common cache TTL: 30 minutes */
export const TTL_30_MINUTES_MS = 30 * MS_PER_MINUTE

/** Common long cache TTL: 1 hour */
export const TTL_1_HOUR_MS = 60 * MS_PER_MINUTE

/** Common extended cache TTL: 6 hours */
export const TTL_6_HOURS_MS = 6 * MS_PER_HOUR

/** API timeout: 10 minutes (600 seconds) */
export const API_TIMEOUT_MS = 600 * MS_PER_SECOND

/** Default API key helper cache TTL: 5 minutes */
export const DEFAULT_API_KEY_HELPER_TTL_MS = 5 * MS_PER_MINUTE

/** Default cache TTL for memoization: 5 minutes */
export const DEFAULT_CACHE_TTL_MS = 5 * MS_PER_MINUTE

/** Max retry delay: 5 minutes */
export const MAX_RETRY_DELAY_MS = 5 * MS_PER_MINUTE

/** Persistent reset cap: 6 hours */
export const PERSISTENT_RESET_CAP_MS = 6 * MS_PER_HOUR
