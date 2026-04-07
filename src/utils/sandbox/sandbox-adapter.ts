// Stub: sandbox features are disabled in UA (no @anthropic-ai/sandbox-runtime)
export const SandboxAdapter = null
export async function runInSandbox(): Promise<null> { return null }
export function shouldAllowManagedSandboxDomainsOnly(): boolean { return false }
export function addToExcludedCommands(_cmd: string): void {}

export type NetworkHostPattern = string
export type SandboxAskCallback = () => Promise<boolean>
export type SandboxDependencyCheck = { name: string; check: () => boolean }
export type SandboxViolationEvent = { type: string; command: string }

export class SandboxManager {
  // Platform & availability
  static isSupportedPlatform(): boolean { return false }
  static isPlatformInEnabledList(): boolean { return false }
  static isSandboxingEnabled(): boolean { return false }
  static areSandboxSettingsLockedByPolicy(): boolean { return false }

  // Commands
  static areUnsandboxedCommandsAllowed(): boolean { return true }
  static isAutoAllowBashIfSandboxedEnabled(): boolean { return false }
  static isUnsandboxedCommandAllowed(_cmd: string): boolean { return true }

  // Profile & config
  static getSandboxProfile(): null { return null }
  static shouldAllowManagedSandboxDomainsOnly(): boolean { return false }
  static getFsReadConfig(): { allowOnly: string[]; denyWithinAllow: string[] } {
    return { allowOnly: [], denyWithinAllow: [] }
  }
  static getFsWriteConfig(): { allowOnly: string[]; denyWithinAllow: string[] } {
    return { allowOnly: [], denyWithinAllow: [] }
  }
  static getNetworkRestrictionConfig(): null { return null }
  static getAllowUnixSockets(): boolean { return true }
  static getIgnoreViolations(): boolean { return false }
  static getProxyPort(): null { return null }
  static getLinuxGlobPatternWarnings(): string[] { return [] }

  // Lifecycle
  static initialize(): void {}
  static async waitForNetworkInitialization(): Promise<void> {}
  static async wrapWithSandbox(cmd: string, _opts?: unknown): Promise<string> { return cmd }
  static cleanupAfterCommand(): void {}

  // Diagnostics
  static checkDependencies(): { errors: string[] } { return { errors: [] } }
}
