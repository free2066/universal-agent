// @ts-nocheck
/**
 * G4: Pre-defined event types for the SyncEventBus.
 *
 * Each constant is a SyncEventDef created on the singleton bus at import time.
 * Import and use these in code that publishes/subscribes to well-known events.
 *
 * Mirrors opencode's built-in event taxonomy.
 */

import { bus } from './index.js'

// ── Session events ────────────────────────────────────────────────────────────

export const SessionEvents = {
  created: bus.define<{
    sessionId: string
    cwd: string
    model?: string
  }>('session.created'),

  updated: bus.define<{
    sessionId: string
    turnCount?: number
    model?: string
  }>('session.updated'),

  ended: bus.define<{
    sessionId: string
    turnCount: number
    durationMs: number
  }>('session.ended'),
} as const

// ── File events ───────────────────────────────────────────────────────────────

export const FileEvents = {
  written: bus.define<{
    path: string
    sizeBytes: number
  }>('file.written'),

  edited: bus.define<{
    path: string
    additions: number
    deletions: number
  }>('file.edited'),
} as const

// ── Snapshot events ───────────────────────────────────────────────────────────

export const SnapshotEvents = {
  taken: bus.define<{
    hash: string
    workTree: string
    fileCount?: number
  }>('snapshot.taken'),
} as const

// ── Worktree events ───────────────────────────────────────────────────────────

export const WorktreeEvents = {
  created: bus.define<{
    worktreePath: string
    worktreeBranch?: string
    slug: string
  }>('worktree.created'),

  merged: bus.define<{
    worktreePath: string
    targetBranch?: string
    slug: string
  }>('worktree.merged'),

  reset: bus.define<{
    worktreePath: string
  }>('worktree.reset'),
} as const

// ── Permission events ─────────────────────────────────────────────────────────

export const PermissionEvents = {
  asked: bus.define<{
    permission: string
    value: string
    sessionId?: string
  }>('permission.asked'),

  replied: bus.define<{
    permission: string
    value: string
    action: 'allow' | 'deny' | 'ask'
  }>('permission.replied'),
} as const
