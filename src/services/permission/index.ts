// @ts-nocheck
/**
 * G3: Permission service public exports.
 *
 * Usage:
 *   import { getPermissionService } from '../permission/index.js'
 *   const perm = getPermissionService()
 *   const action = perm.evaluate('bash', 'rm -rf /')  // 'deny' | 'ask' | 'allow'
 */

export {
  PermissionService,
  getPermissionService,
} from './PermissionService.js'

export type {
  PermissionAction,
  PermissionRule,
  PermissionRequest,
} from './PermissionService.js'
