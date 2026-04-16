// @ts-nocheck
/**
 * G4: SyncEventBus — lightweight event-sourcing bus.
 *
 * Inspired by opencode's sync/index.ts but without SQLite dependency.
 * Uses JSONL persistence to ~/.uagent/events/<YYYY-MM-DD>.jsonl.
 *
 * Architecture:
 *   - define()    — register a typed event definition
 *   - publish()   — emit event to all in-process subscribers + optional JSONL file
 *   - subscribe() — register a handler (returns unsubscribe function)
 *   - getEvents() — replay events from today's JSONL file
 *   - flush()     — force-write buffered events to disk
 *
 * All operations are synchronous for simplicity; I/O is fire-and-forget unless
 * flush() is called explicitly.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

// ──────────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SyncEventDef<T = unknown> {
  /** Unique event type string, e.g. "session.created" */
  readonly type: string
  /** Schema version — bump when the data shape changes */
  readonly version: number
}

export interface SyncEvent<T = unknown> {
  /** Unique event id (UUID v4) */
  id: string
  /** Event type string matching SyncEventDef.type */
  type: string
  /** Schema version */
  version: number
  /**
   * Aggregate id — the entity this event belongs to.
   * For session events this is the sessionId; for file events it's the path.
   */
  aggregateId: string
  /** Event payload */
  data: T
  /** ISO-8601 timestamp */
  timestamp: string
}

type Handler<T = unknown> = (event: SyncEvent<T>) => void

// ──────────────────────────────────────────────────────────────────────────────
//  SyncEventBus
// ──────────────────────────────────────────────────────────────────────────────

/** Directory where JSONL event log files are stored */
const EVENTS_DIR = path.join(os.homedir(), '.uagent', 'events')
const MAX_BUFFERED_EVENTS_ON_FAILURE = 1000

/** Cached date string for todayFile (refreshed every minute) */
let _cachedDate: string | null = null
let _cachedTimestamp: number = 0

function todayFile(): string {
  const now = Date.now()
  // Cache for up to 1 minute (date changes are rare, and 1-min delay is acceptable for logs)
  if (_cachedDate && now - _cachedTimestamp < 60000) {
    return path.join(EVENTS_DIR, `${_cachedDate}.jsonl`)
  }
  const d = new Date()
  // toISOString() returns "YYYY-MM-DDTHH:mm:ss.sssZ", slice(0,10) gives "YYYY-MM-DD"
  _cachedDate = d.toISOString().slice(0, 10)
  _cachedTimestamp = now
  return path.join(EVENTS_DIR, `${_cachedDate}.jsonl`)
}

export class SyncEventBus {
  private defs = new Map<string, SyncEventDef>()
  private handlers = new Map<string, Set<Handler>>()
  /** Buffer of serialized events waiting to be flushed to disk */
  private writeBuffer: string[] = []
  /** Whether to persist events to JSONL (default: true) */
  readonly persist: boolean

  constructor(opts: { persist?: boolean } = {}) {
    this.persist = opts.persist ?? true
  }

  // ── Definition ────────────────────────────────────────────────────────────

  /**
   * Register a typed event definition.  Idempotent — re-registering the same
   * type returns the existing definition without overwriting it.
   */
  define<T>(type: string, version = 1): SyncEventDef<T> {
    const existing = this.defs.get(type)
    if (existing) return existing as SyncEventDef<T>
    const def: SyncEventDef<T> = { type, version }
    this.defs.set(type, def)
    return def
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * Publish an event.
   *  1. Creates a SyncEvent object with a new UUID
   *  2. Notifies all in-process subscribers
   *  3. Buffers the serialized event for disk persistence
   */
  publish<T>(def: SyncEventDef<T>, aggregateId: string, data: T): SyncEvent<T> {
    const event: SyncEvent<T> = {
      id: crypto.randomUUID(),
      type: def.type,
      version: def.version,
      aggregateId,
      data,
      timestamp: new Date().toISOString(),
    }

    // Notify in-process subscribers
    const handlers = this.handlers.get(def.type)
    if (handlers) {
      for (const h of handlers) {
        try {
          h(event as SyncEvent<unknown>)
        } catch (error) {
          logForDebugging(
            `[SyncEventBus] subscriber failed for ${event.type} (${event.aggregateId}): ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
      }
    }

    // Buffer for disk persistence
    if (this.persist) {
      this.writeBuffer.push(JSON.stringify(event))
      // Auto-flush every 10 events to keep memory usage low
      if (this.writeBuffer.length >= 10) {
        this.flush()
      }
    }

    return event
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to events of a given type.
   * Returns an unsubscribe function.
   */
  subscribe<T>(
    def: SyncEventDef<T>,
    handler: (event: SyncEvent<T>) => void,
  ): () => void {
    let set = this.handlers.get(def.type)
    if (!set) {
      set = new Set()
      this.handlers.set(def.type, set)
    }
    set.add(handler as Handler)

    return () => {
      set?.delete(handler as Handler)
    }
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * Read events from today's JSONL file (most recent events first if limit is
   * applied).  Optionally filter by aggregateId.
   */
  getEvents(opts: { aggregateId?: string; limit?: number } = {}): SyncEvent[] {
    const file = todayFile()
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      let events = raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as SyncEvent
          } catch {
            return null
          }
        })
        .filter((e): e is SyncEvent => e !== null)

      if (opts.aggregateId) {
        events = events.filter(e => e.aggregateId === opts.aggregateId)
      }

      if (opts.limit && opts.limit > 0) {
        events = events.slice(-opts.limit)
      }

      return events
    } catch (error) {
      logForDebugging(
        `[SyncEventBus] failed to replay events from ${file}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      return []
    }
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  /**
   * Write all buffered events to disk.
   * Safe to call multiple times — a no-op when the buffer is empty.
   */
  flush(): void {
    if (!this.persist || this.writeBuffer.length === 0) return

    try {
      fs.mkdirSync(EVENTS_DIR, { recursive: true })
      fs.appendFileSync(todayFile(), this.writeBuffer.join('\n') + '\n', 'utf-8')
      this.writeBuffer = []
    } catch (error) {
      logForDebugging(
        `[SyncEventBus] failed to persist ${this.writeBuffer.length} event(s): ${errorMessage(error)}`,
        { level: 'warn' },
      )

      if (this.writeBuffer.length > MAX_BUFFERED_EVENTS_ON_FAILURE) {
        const droppedCount = this.writeBuffer.length - MAX_BUFFERED_EVENTS_ON_FAILURE
        this.writeBuffer = this.writeBuffer.slice(-MAX_BUFFERED_EVENTS_ON_FAILURE)
        logForDebugging(
          `[SyncEventBus] dropped ${droppedCount} buffered event(s) after repeated persist failures to cap memory usage`,
          { level: 'warn' },
        )
      }
    }
  }

  /** Clear all in-process state (useful for tests). */
  reset(): void {
    this.defs.clear()
    this.handlers.clear()
    this.writeBuffer = []
  }
}
