// @ts-nocheck
/**
 * G6: IDE service public exports.
 *
 * Usage:
 *   import { getIdeService, SUPPORTED_IDES } from '../ide/index.js'
 *   const ide = getIdeService()
 *   const detected = ide.detect()
 *   await ide.install(detected)
 */

export { IdeService, getIdeService, SUPPORTED_IDES } from './IdeService.js'
export type { IdeInfo } from './IdeService.js'
