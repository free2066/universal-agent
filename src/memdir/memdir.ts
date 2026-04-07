/**
 * memdir/memdir.ts — Memory directory management
 *
 * Mirrors claude-code's memdir/memdir.ts.
 * Re-exports the core memory store functionality.
 */

export {
  MemoryType,
  MemorySource,
  MemoryItem,
  RecallOptions,
  IngestResult,
  ITERATION_TTL_MS,
  getMemoryStore,
  triggerIncrementalIngest,
} from '../core/memory/memory-store.js';
