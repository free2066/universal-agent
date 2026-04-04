/**
 * handlers/shared.ts — Handler 共享类型与工具函数
 */
import chalk from 'chalk';
import type { Interface as ReadlineInterface } from 'readline';
import type { AgentCore } from '../../../core/agent.js';
import { printStatusBar } from '../../statusbar.js';
import { HookRunner } from '../../../core/hooks.js';
import type { SessionLogger } from '../../session-logger.js';

export interface SlashContext {
  agent: AgentCore;
  rl: ReadlineInterface;
  hookRunner: HookRunner;
  sessionLogger: SessionLogger;
  options: { domain: string; verbose?: boolean };
  SESSION_ID: string;
  getModelDisplayName: (id: string) => string;
  makePrompt: (domain: string, model?: string) => string;
  loadLastSnapshot: () => { messages: unknown[]; savedAt: number } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveSnapshot: (id: string, history: any[]) => void;
  formatAge: (ts: number) => string;
  inferProviderEnvKey: (msg: string) => string | undefined;
}

/** 用于 rl.prompt() + printStatusBar() 的快捷结束动作 */
export function done(rl: ReadlineInterface): true {
  rl.prompt();
  printStatusBar();
  return true;
}

/** 带 pause/resume 包装的异步 LLM 流式调用 */
export async function streamWithPause(
  rl: ReadlineInterface,
  fn: () => Promise<void>,
): Promise<void> {
  rl.pause();
  process.stdout.write('\n');
  try {
    await fn();
    process.stdout.write('\n');
  } finally {
    rl.resume();
  }
}
