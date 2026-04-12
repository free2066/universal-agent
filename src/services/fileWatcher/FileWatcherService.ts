// @ts-nocheck
/**
 * F6: File system watcher service.
 *
 * Watches the project directory for external changes (files edited outside
 * the agent, git checkouts, etc.) and notifies the LSP manager so diagnostics
 * stay fresh without requiring the user to manually trigger a re-check.
 *
 * Implementation uses chokidar (already a dependency via Claude Code).
 * Control via environment variable:
 *   UAGENT_FILEWATCHER=1   — enable (default: disabled)
 *
 * Ignored paths: node_modules/, .git/, dist/, .next/, build/, __pycache__/
 */

import { EventEmitter } from 'events'
import path from 'path'
import { errorMessage } from '../../utils/errors.js'

// Lazily require chokidar to avoid import overhead when watcher is disabled
let chokidar: typeof import('chokidar') | null = null
function getChokidar() {
  if (!chokidar) {
    try {
      chokidar = require('chokidar') as typeof import('chokidar')
    } catch {
      return null
    }
  }
  return chokidar
}

export type FileChangeEvent = 'add' | 'change' | 'unlink'

export interface FileChangeInfo {
  filePath: string
  event: FileChangeEvent
  timestamp: Date
}

/** Directories to always ignore */
const IGNORED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  '__pycache__',
  '.cache',
  'coverage',
  '.turbo',
]

const IGNORED_PATTERN = new RegExp(
  `(${IGNORED_DIRS.map(d => `[/\\\\]${d}[/\\\\]`).join('|')}|[/\\\\]${IGNORED_DIRS.map(d => `${d}$`).join('|[/\\\\]')})`,
)

export class FileWatcherService extends EventEmitter {
  private watcher: ReturnType<typeof import('chokidar').watch> | null = null
  private readonly dir: string
  private _running = false

  constructor(dir: string) {
    super()
    this.dir = path.resolve(dir)
  }

  /**
   * Start watching the directory.
   * No-op if already running.
   */
  start(): boolean {
    if (this._running) return true
    const chok = getChokidar()
    if (!chok) return false

    try {
      this.watcher = chok.watch(this.dir, {
        ignored: IGNORED_PATTERN,
        persistent: true,
        ignoreInitial: true,   // don't fire for existing files
        awaitWriteFinish: {    // debounce rapid saves
          stabilityThreshold: 300,
          pollInterval: 100,
        },
        depth: 15,
      })

      for (const event of ['add', 'change', 'unlink'] as FileChangeEvent[]) {
        this.watcher.on(event, (filePath: string) => {
          const info: FileChangeInfo = {
            filePath: path.resolve(filePath),
            event,
            timestamp: new Date(),
          }
          this.emit('change', info)
        })
      }

      this.watcher.on('error', (err: unknown) => {
        // Log watcher errors (e.g. ENOSPC when inotify limit is reached) so they are diagnosable
        process.stderr.write(`[FileWatcherService] watcher error: ${errorMessage(err)}\n`)
      })

      this._running = true
      return true
    } catch {
      return false
    }
  }

  /**
   * Stop watching. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close().catch((err: unknown) => {
        process.stderr.write(`[FileWatcherService] watcher.close() failed: ${errorMessage(err)}\n`)
      })
      this.watcher = null
    }
    // Remove all external 'change' listeners to prevent memory leaks
    this.removeAllListeners()
    this._running = false
  }

  isRunning(): boolean {
    return this._running
  }
}

// ── Singleton ─────────────────────────────────────────────

let _watcher: FileWatcherService | null = null

export function getFileWatcher(dir?: string): FileWatcherService {
  if (!_watcher) {
    _watcher = new FileWatcherService(dir ?? process.cwd())
  }
  return _watcher
}

/**
 * Start the file watcher if UAGENT_FILEWATCHER=1.
 * Should be called once at session startup.
 * Returns true if watcher was started.
 */
export function startFileWatcherIfEnabled(
  dir: string,
  onChangeFn?: (info: FileChangeInfo) => void,
): boolean {
  if (process.env.UAGENT_FILEWATCHER !== '1') return false

  const watcher = getFileWatcher(dir)
  if (onChangeFn) {
    watcher.on('change', onChangeFn)
  }
  return watcher.start()
}
