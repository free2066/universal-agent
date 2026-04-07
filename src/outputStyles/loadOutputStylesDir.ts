/**
 * outputStyles/loadOutputStylesDir.ts — Output style directory loader
 *
 * Mirrors claude-code's outputStyles/loadOutputStylesDir.ts.
 * Re-exports output style loading from core/output-styles/loader.ts.
 */

export {
  OutputStyleConfig,
  BUILTIN_STYLES,
  getAllOutputStyles,
  getOutputStyle,
  getEffectiveOutputStyle,
  buildOutputStylePrompt,
  invalidateOutputStyleCache,
} from '../core/output-styles/loader.js';
