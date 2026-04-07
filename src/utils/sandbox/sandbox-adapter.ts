// Stub: requires @anthropic-ai/sandbox-runtime
export const SandboxAdapter = null
export async function runInSandbox(): Promise<null> { return null }
export function shouldAllowManagedSandboxDomainsOnly(): boolean { return false }
export function addToExcludedCommands(_cmd: string): void {}

export type NetworkHostPattern = string
export type SandboxAskCallback = () => Promise<boolean>
export type SandboxDependencyCheck = { name: string; check: () => boolean }
export type SandboxViolationEvent = { type: string; command: string }

export class SandboxManager {
  static isSandboxingEnabled(): boolean { return false }
  static areUnsandboxedCommandsAllowed(): boolean { return true }
  static isAutoAllowBashIfSandboxedEnabled(): boolean { return false }
  static isUnsandboxedCommandAllowed(_cmd: string): boolean { return true }
  static getSandboxProfile(): null { return null }
  static shouldAllowManagedSandboxDomainsOnly(): boolean { return false }
}
