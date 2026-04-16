/**
 * Headless execution module
 * 
 * Contains runHeadless and runHeadlessStreaming functions for non-interactive CLI mode.
 * These functions are re-exported from print.ts for module organization.
 */

// Re-export from the main print.ts file
// Note: The actual implementations remain in print.ts due to deep closure dependencies
export {
  runHeadless,
  runHeadlessStreaming,
} from '../print.js'
