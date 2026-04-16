/**
 * Utility functions for print module
 * 
 * These functions are re-exported from print.ts for module organization.
 * The actual implementations remain in print.ts to avoid code duplication.
 */

// Re-export from the main print.ts file
export {
  toBlocks,
  joinPromptValues,
  canBatchWith,
} from '../print.js'

// Re-export type from print.ts
export type { PromptValue } from '../print.js'
