// @ts-nocheck
/**
 * G6: IdeService — IDE detection and extension installation helper.
 *
 * Mirrors opencode's ide/index.ts:
 *   - Detects the currently running IDE via environment variables
 *   - Lists supported IDEs (VS Code, Cursor, Windsurf, etc.)
 *   - Checks whether the Claude Code extension is installed
 *   - Installs the extension via `<cmd> --install-extension <extensionId>`
 *
 * Supported IDEs:
 *   Visual Studio Code, VS Code Insiders, Cursor, Windsurf, VSCodium
 */

import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

// ──────────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────────

export interface IdeInfo {
  /** Human-readable display name */
  name: string
  /** CLI command used to interact with the IDE */
  cmd: string
  /**
   * VS Code marketplace extension id to install/check.
   * Undefined for IDEs that don't support the `--install-extension` flag.
   */
  extensionId?: string
  /**
   * Environment variable or process identifier used for detection.
   * Multiple values may be checked (OR semantics).
   */
  detectEnv?: string[]
}

/** All IDEs known to support the VS Code extension API */
export const SUPPORTED_IDES: IdeInfo[] = [
  {
    name: 'Visual Studio Code',
    cmd: 'code',
    extensionId: 'anthropic.claude-code',
    detectEnv: ['VSCODE_PID', 'VSCODE_IPC_HOOK'],
  },
  {
    name: 'VS Code Insiders',
    cmd: 'code-insiders',
    extensionId: 'anthropic.claude-code',
    detectEnv: ['VSCODE_PID', 'VSCODE_IPC_HOOK'],
  },
  {
    name: 'Cursor',
    cmd: 'cursor',
    extensionId: 'anthropic.claude-code',
    detectEnv: ['CURSOR_TRACE_ID', 'CURSOR_PID'],
  },
  {
    name: 'Windsurf',
    cmd: 'windsurf',
    extensionId: 'anthropic.claude-code',
    detectEnv: ['WINDSURF_PID', 'WINDSURF_IPC_HOOK'],
  },
  {
    name: 'VSCodium',
    cmd: 'codium',
    extensionId: 'anthropic.claude-code',
    detectEnv: ['VSCODIUM_PID'],
  },
]

// ──────────────────────────────────────────────────────────────────────────────
//  IdeService
// ──────────────────────────────────────────────────────────────────────────────

export class IdeService {
  // ── Detection ──────────────────────────────────────────────────────────────

  /**
   * Detect the IDE currently running this process by checking environment
   * variables and the TERM_PROGRAM / GIT_ASKPASS heuristics used by opencode.
   *
   * Returns the best matching IdeInfo, or null if not detected.
   */
  detect(): IdeInfo | null {
    const env = process.env

    // TERM_PROGRAM is set by VS Code's integrated terminal
    const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? ''
    if (termProgram.includes('vscode')) {
      // Distinguish Cursor/Windsurf from standard VS Code by checking
      // GIT_ASKPASS path which often contains the app name
      const gitAskpass = env.GIT_ASKPASS?.toLowerCase() ?? ''
      if (gitAskpass.includes('cursor')) {
        return SUPPORTED_IDES.find(i => i.cmd === 'cursor') ?? null
      }
      if (gitAskpass.includes('windsurf')) {
        return SUPPORTED_IDES.find(i => i.cmd === 'windsurf') ?? null
      }
      if (gitAskpass.includes('codium') || gitAskpass.includes('vscodium')) {
        return SUPPORTED_IDES.find(i => i.cmd === 'codium') ?? null
      }
      // Check VSCODE_INJECTION which cursor overrides
      const injection = (env.VSCODE_INJECTION ?? '').toLowerCase()
      if (injection.includes('cursor')) {
        return SUPPORTED_IDES.find(i => i.cmd === 'cursor') ?? null
      }
      // Default VS Code
      const insiders = env.VSCODE_IPC_HOOK?.includes('insiders') ?? false
      return SUPPORTED_IDES.find(
        i => i.cmd === (insiders ? 'code-insiders' : 'code'),
      ) ?? null
    }

    // Fallback: check per-IDE detectEnv variables
    for (const ide of SUPPORTED_IDES) {
      if (ide.detectEnv?.some(v => env[v])) {
        return ide
      }
    }

    return null
  }

  /** Return a copy of the supported IDE list. */
  list(): IdeInfo[] {
    return [...SUPPORTED_IDES]
  }

  // ── Availability check ─────────────────────────────────────────────────────

  /**
   * Check whether the IDE CLI command is available on PATH.
   */
  async isCLIAvailable(ide: IdeInfo): Promise<boolean> {
    const { code } = await execFileNoThrow(ide.cmd, ['--version'])
    return code === 0
  }

  /**
   * Check whether the Claude Code extension is already installed.
   * Uses `<cmd> --list-extensions` and looks for the extensionId.
   */
  async isExtensionInstalled(ide: IdeInfo): Promise<boolean> {
    if (!ide.extensionId) return false
    const { code, stdout } = await execFileNoThrow(ide.cmd, [
      '--list-extensions',
    ])
    if (code !== 0) return false
    return stdout
      .split('\n')
      .map(l => l.trim().toLowerCase())
      .includes(ide.extensionId.toLowerCase())
  }

  // ── Installation ──────────────────────────────────────────────────────────

  /**
   * Install the extension for the given IDE.
   * Throws if the IDE CLI is not available or installation fails.
   */
  async install(ide: IdeInfo): Promise<void> {
    if (!ide.extensionId) {
      throw new Error(`IDE "${ide.name}" does not have a known extension id`)
    }

    const cliAvailable = await this.isCLIAvailable(ide)
    if (!cliAvailable) {
      throw new Error(
        `IDE CLI "${ide.cmd}" not found on PATH. ` +
          `Please open the Command Palette in ${ide.name} and run ` +
          `"Shell Command: Install '${ide.cmd}' command in PATH".`,
      )
    }

    const { code, stderr } = await execFileNoThrow(ide.cmd, [
      '--install-extension',
      ide.extensionId,
    ])

    if (code !== 0) {
      throw new Error(
        `Failed to install extension "${ide.extensionId}" for ${ide.name}: ${stderr}`,
      )
    }
  }

  /**
   * Full install flow: detect → check → install.
   * Returns a status string describing what happened.
   */
  async autoInstall(): Promise<{
    ide: IdeInfo | null
    alreadyInstalled: boolean
    installed: boolean
    error?: string
  }> {
    const ide = this.detect()
    if (!ide) {
      return { ide: null, alreadyInstalled: false, installed: false, error: 'No supported IDE detected' }
    }

    const alreadyInstalled = await this.isExtensionInstalled(ide)
    if (alreadyInstalled) {
      return { ide, alreadyInstalled: true, installed: false }
    }

    try {
      await this.install(ide)
      return { ide, alreadyInstalled: false, installed: true }
    } catch (err) {
      return {
        ide,
        alreadyInstalled: false,
        installed: false,
        error: (err as Error).message,
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Singleton
// ──────────────────────────────────────────────────────────────────────────────

let _instance: IdeService | null = null

export function getIdeService(): IdeService {
  if (!_instance) _instance = new IdeService()
  return _instance
}
