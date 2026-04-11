// @ts-nocheck
/**
 * F8: Lightweight Pty (pseudo-terminal) service.
 *
 * Inspired by opencode's pty/ module. Provides managed pseudo-terminal sessions
 * that agents can create, write to, resize, and read output from.
 *
 * Uses node-pty if available (optional dependency). Falls back to a
 * child_process-based simulation when node-pty is not installed.
 *
 * Environment: UAGENT_PTY=1 to enable (default: disabled for safety)
 *
 * Buffer design:
 *   - Each pty keeps a rolling output buffer (max BUFFER_LIMIT bytes)
 *   - Output callbacks are registered per-pty and called on data
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import os from 'os'
import { logForDebugging } from '../../utils/debug.js'

/** Max rolling output buffer per pty: 2 MB (same as opencode) */
const BUFFER_LIMIT = 2 * 1024 * 1024

export type PtyStatus = 'running' | 'exited'

export interface PtyInfo {
  id: string
  pid: number
  command: string
  args: string[]
  cwd: string
  status: PtyStatus
  exitCode?: number
}

interface PtyEntry {
  info: PtyInfo
  buffer: string
  emitter: EventEmitter
  pty: any  // node-pty IPty or child_process.ChildProcess
}

// ── Try to load node-pty ────────────────────────────────────
function loadNodePty(): typeof import('node-pty') | null {
  try {
    // node-pty is an optional dep — ignore if missing
    return require('node-pty') as typeof import('node-pty')
  } catch {
    return null
  }
}

// ── PtyService ──────────────────────────────────────────────

export class PtyService {
  private readonly ptys = new Map<string, PtyEntry>()
  private readonly nodePty = loadNodePty()

  /**
   * Create a new pty session.
   * Falls back to a plain child_process spawn if node-pty is unavailable.
   */
  create(input: {
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
  }): PtyInfo {
    const id = randomUUID()
    const cwd = input.cwd ?? process.cwd()
    const args = input.args ?? []
    const cols = input.cols ?? 80
    const rows = input.rows ?? 24
    const env = {
      ...process.env,
      ...input.env,
      TERM: 'xterm-256color',
      UAGENT_TERMINAL: '1',
    } as Record<string, string>

    const emitter = new EventEmitter()
    let pid = 0
    let ptyHandle: any

    if (this.nodePty) {
      // Use native pty
      ptyHandle = this.nodePty.spawn(input.command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
      pid = ptyHandle.pid

      ptyHandle.onData((data: string) => {
        const entry = this.ptys.get(id)
        if (!entry) return
        entry.buffer += data
        // Rolling window: trim to BUFFER_LIMIT
        if (entry.buffer.length > BUFFER_LIMIT) {
          entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_LIMIT)
        }
        emitter.emit('data', data)
      })

      ptyHandle.onExit(({ exitCode }: { exitCode: number }) => {
        const entry = this.ptys.get(id)
        if (entry) {
          entry.info.status = 'exited'
          entry.info.exitCode = exitCode
        }
        emitter.emit('exit', exitCode)
      })
    } else {
      // Fallback: child_process spawn (no pty, but functional for non-interactive commands)
      ptyHandle = spawn(input.command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      pid = ptyHandle.pid ?? 0

      const handleData = (chunk: Buffer) => {
        const data = chunk.toString()
        const entry = this.ptys.get(id)
        if (!entry) return
        entry.buffer += data
        if (entry.buffer.length > BUFFER_LIMIT) {
          entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_LIMIT)
        }
        emitter.emit('data', data)
      }

      ptyHandle.stdout?.on('data', handleData)
      ptyHandle.stderr?.on('data', handleData)
      ptyHandle.on('close', (code: number) => {
        const entry = this.ptys.get(id)
        if (entry) {
          entry.info.status = 'exited'
          entry.info.exitCode = code
        }
        emitter.emit('exit', code)
      })
    }

    const info: PtyInfo = {
      id,
      pid,
      command: input.command,
      args,
      cwd,
      status: 'running',
    }

    this.ptys.set(id, { info, buffer: '', emitter, pty: ptyHandle })
    return info
  }

  /** Write data (keyboard input) to a pty. */
  write(id: string, data: string): void {
    const entry = this.ptys.get(id)
    if (!entry || entry.info.status !== 'running') return

    if (this.nodePty && entry.pty?.write) {
      entry.pty.write(data)
    } else {
      entry.pty?.stdin?.write?.(data)
    }
  }

  /** Resize the pty (cols × rows). */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.ptys.get(id)
    if (!entry || entry.info.status !== 'running') return
    if (this.nodePty && entry.pty?.resize) {
      try { entry.pty.resize(cols, rows) } catch { /* ignore */ }
    }
  }

  /** Kill a pty session. */
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    try {
      if (this.nodePty && entry.pty?.kill) {
        entry.pty.kill(signal)
      } else {
        entry.pty?.kill?.(signal)
      }
    } catch (error) {
      logForDebugging(
        `[PtyService] failed to kill pty ${id} (pid=${entry.info.pid}, signal=${signal}): ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
    }
    entry.info.status = 'exited'
  }

  /** Get the full buffered output for a pty. */
  getBuffer(id: string): string {
    return this.ptys.get(id)?.buffer ?? ''
  }

  /** List all pty sessions. */
  list(): PtyInfo[] {
    return [...this.ptys.values()].map(e => ({ ...e.info }))
  }

  /** Get a single pty by ID. */
  get(id: string): PtyInfo | undefined {
    const entry = this.ptys.get(id)
    return entry ? { ...entry.info } : undefined
  }

  /**
   * Subscribe to output data from a pty.
   * @returns Unsubscribe function
   */
  onData(id: string, cb: (data: string) => void): () => void {
    const entry = this.ptys.get(id)
    if (!entry) return () => {}
    entry.emitter.on('data', cb)
    return () => entry.emitter.off('data', cb)
  }

  /**
   * Subscribe to pty exit.
   * @returns Unsubscribe function
   */
  onExit(id: string, cb: (code: number) => void): () => void {
    const entry = this.ptys.get(id)
    if (!entry) return () => {}
    entry.emitter.on('exit', cb)
    return () => entry.emitter.off('exit', cb)
  }

  /** Remove a pty entry from memory (after it has exited). */
  remove(id: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    if (entry.info.status === 'running') this.kill(id)
    // Clean up all listeners on the emitter to prevent memory leaks
    entry.emitter.removeAllListeners()
    this.ptys.delete(id)
  }

  /** Kill all running ptys (called at process exit). */
  killAll(): void {
    for (const [id, e] of this.ptys.entries()) {
      if (e.info.status === 'running') this.kill(id)
    }
  }
}

// ── Singleton ─────────────────────────────────────────────

let _ptyService: PtyService | null = null

export function getPtyService(): PtyService {
  if (!_ptyService) {
    _ptyService = new PtyService()
    // Register cleanup so all ptys are killed when the process exits
    import('../../utils/cleanupRegistry.js').then(({ registerCleanup }) => {
      registerCleanup(async () => { _ptyService?.killAll() })
    }).catch(() => {})
  }
  return _ptyService
}

export function isPtyEnabled(): boolean {
  return process.env.UAGENT_PTY === '1'
}
