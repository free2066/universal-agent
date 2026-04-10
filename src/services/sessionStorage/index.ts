// @ts-nocheck
/**
 * R4: Session storage public exports.
 *
 * Usage:
 *   import { getSessionDB } from '../sessionStorage/index.js'
 *   const db = getSessionDB()
 *   db.saveSession({ id, title, model, createdAt, updatedAt, messageCount })
 *   db.appendMessage({ id, sessionId, role, content, createdAt })
 *   const sessions = db.listSessions(20)
 */

export { SessionDB, getSessionDB } from './SessionDB.js'
export type { SessionMeta, StoredMessage } from './SessionDB.js'
