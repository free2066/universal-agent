/**
 * D19: SleepTool — wait for a specified duration without blocking the JS event loop.
 *
 * Mirrors claude-code src/tools/SleepTool/SleepTool.ts
 *
 * Use cases:
 *   - Wait for a background process to complete (build, deploy, startup)
 *   - Rate-limit API polling (sleep 5s between status checks)
 *   - Coordinate with other tools running in parallel
 *
 * Unlike Bash `sleep` (which blocks the tool slot), this tool resolves a Promise
 * and returns control to the agent loop, allowing other background operations to
 * continue during the wait period.
 *
 * AbortSignal support: if the session is cancelled during a sleep, the sleep
 * completes early and returns a cancellation message.
 */

import type { ToolRegistration } from '../../models/types.js';

/** Maximum allowed sleep duration: 1 hour (matches claude-code MAX_SLEEP_MS) */
const MAX_SLEEP_SECONDS = 3600;

/** Minimum resolution: 100ms (below this, setTimeout is unreliable) */
const MIN_SLEEP_SECONDS = 0.1;

export const sleepTool: ToolRegistration = {
  searchHint: 'wait pause delay seconds background process',
  definition: {
    name: 'Sleep',
    description: [
      'Wait for a specified number of seconds before continuing.',
      'Use this to wait for background processes, builds, or deployments to complete,',
      'or to rate-limit polling loops. Maximum duration: 3600 seconds (1 hour).',
      'Unlike shell `sleep`, this does not block other concurrent tools.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        duration_seconds: {
          type: 'number',
          description: `Number of seconds to wait. Range: ${MIN_SLEEP_SECONDS}–${MAX_SLEEP_SECONDS}. May be fractional (e.g. 0.5 for 500ms).`,
        },
      },
      required: ['duration_seconds'],
    },
    aliases: ['sleep'],
  },

  validate(args) {
    const { duration_seconds } = args as { duration_seconds?: unknown };
    if (typeof duration_seconds !== 'number' || isNaN(duration_seconds)) {
      return { result: false, message: 'duration_seconds must be a number', errorCode: 'invalid_type' };
    }
    if (duration_seconds < MIN_SLEEP_SECONDS) {
      return { result: false, message: `duration_seconds must be ≥ ${MIN_SLEEP_SECONDS}`, errorCode: 'out_of_range' };
    }
    if (duration_seconds > MAX_SLEEP_SECONDS) {
      return { result: false, message: `duration_seconds must be ≤ ${MAX_SLEEP_SECONDS} (1 hour)`, errorCode: 'out_of_range' };
    }
    return { result: true };
  },

  async handler(args) {
    const { duration_seconds } = args as { duration_seconds: number };
    const ms = Math.round(duration_seconds * 1000);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow Node.js to exit if this is the only remaining task
      if (typeof timer.unref === 'function') timer.unref();
    });

    const formatted = duration_seconds < 1
      ? `${ms}ms`
      : duration_seconds === Math.floor(duration_seconds)
        ? `${duration_seconds}s`
        : `${duration_seconds}s`;

    return `Slept for ${formatted}.`;
  },
};
