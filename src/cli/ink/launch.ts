/**
 * launch.ts — Ink REPL launcher.
 *
 * Provides runInkREPL() as a drop-in replacement for runREPL() from repl.ts.
 * Uses React + Ink to render the terminal UI.
 *
 * Activated via:
 *   - UAGENT_UI=ink environment variable
 *   - --ui=ink CLI flag (handled in cli/index.ts)
 *
 * Falls back to readline REPL on non-TTY environments (pipes, CI).
 */

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import type { AgentCore } from '../../core/agent.js';
import { modelManager } from '../../models/model-manager.js';
import { loadLocalPlugins } from '../../core/domain-router.js';

export interface InkReplOptions {
  domain: string;
  verbose?: boolean;
}

export interface InkReplExtra {
  initialPrompt?: string;
  continueSession?: boolean;
  resumeSessionId?: string;
  inferProviderEnvKey?: (msg: string) => string | undefined;
  notification?: boolean | string;
}

/**
 * Run the Ink-based REPL.
 * Returns a Promise that resolves when the user exits (Ctrl+C or /exit).
 */
export async function runInkREPL(
  agent: AgentCore,
  options: InkReplOptions,
  extra: InkReplExtra = {},
): Promise<void> {
  // Load plugins before UI starts
  await loadLocalPlugins(process.cwd()).catch(() => {});

  const SESSION_ID = Date.now().toString(16).slice(-8);
  const currentModel = modelManager.getCurrentModel('main');

  // Friendly model name resolution
  let modelDisplayName = currentModel;
  try {
    const { friendlyName } = await import('../model-picker.js');
    const wqMap: Record<string, string> = {};
    (process.env.WQ_MODELS || '').split(',').forEach((entry) => {
      const [id, ...nameParts] = entry.trim().split(':');
      if (nameParts.length > 0 && id) wqMap[id.trim()] = nameParts.join(':').trim();
    });
    modelDisplayName = wqMap[currentModel] ?? friendlyName(currentModel);
  } catch { /* non-fatal */ }

  // Context length from profile
  let contextLength = 128000;
  try {
    const profile = modelManager.listProfiles().find((p) => p.name === currentModel);
    if (profile?.contextLength) contextLength = profile.contextLength;
  } catch { /* non-fatal */ }

  // Restore session if requested
  if (extra.resumeSessionId || extra.continueSession) {
    try {
      const { loadLastSnapshot, loadSnapshot } = await import('../../core/memory/session-snapshot.js');
      const snap = extra.resumeSessionId
        ? loadSnapshot(extra.resumeSessionId)
        : loadLastSnapshot();
      if (snap && snap.messages.length >= 2) {
        agent.setHistory(snap.messages);
        process.stderr.write(`  Resumed session (${snap.messages.length} messages)\n`);
      }
    } catch { /* non-fatal */ }
  }

  // ── Startup hint: show last session availability ───────────────────────
  let startupHint: string | undefined;
  if (!extra.resumeSessionId && !extra.continueSession) {
    try {
      const { loadLastSnapshot } = await import('../../core/memory/session-snapshot.js');
      const snap = loadLastSnapshot();
      if (snap && snap.messages.length >= 2) {
        const ageMs = Date.now() - snap.savedAt;
        let ageStr: string;
        if (ageMs < 60000) ageStr = `${Math.round(ageMs / 1000)}s ago`;
        else if (ageMs < 3600000) ageStr = `${Math.round(ageMs / 60000)}m ago`;
        else if (ageMs < 86400000) ageStr = `${Math.round(ageMs / 3600000)}h ago`;
        else ageStr = `${Math.round(ageMs / 86400000)}d ago`;
        startupHint = `Last session available (${ageStr}, ${snap.messages.length} messages) — type /resume to restore`;
      }
    } catch { /* non-fatal */ }
  }

  // ── Startup: append custom slash commands from hookRunner ─────────────
  try {
    const { HookRunner } = await import('../../core/hooks.js');
    const hookRunner = new HookRunner(process.cwd());
    const customCmds = hookRunner.listSlashCommands();
    if (customCmds.length > 0) {
      const cmdStr = `Custom commands: ${customCmds.map((c: { command: string }) => c.command).join('  ')}`;
      startupHint = startupHint ? `${startupHint}\n${cmdStr}` : cmdStr;
    }
  } catch { /* non-fatal */ }

  return new Promise<void>((resolve) => {
    const { unmount } = render(
      React.createElement(App, {
        agent,
        domain: options.domain,
        verbose: options.verbose,
        sessionId: SESSION_ID,
        modelDisplayName,
        contextLength,
        initialPrompt: extra.initialPrompt,
        inferProviderEnvKey: extra.inferProviderEnvKey,
        startupHint,
        onExit: () => {
          // Save session snapshot
          const history = agent.getHistory();
          if (history.length >= 2) {
            import('../../core/memory/session-snapshot.js').then(({ saveSnapshot }) => {
              try { saveSnapshot(`session-${SESSION_ID}`, history); } catch { /* non-fatal */ }
            }).catch(() => {});
          }
          // ── Dream Mode: auto-ingest insights on exit ─────────────────────
          if (history.length >= 4) {
            import('../../core/memory/memory-store.js').then(({ getMemoryStore }) => {
              const store = getMemoryStore(process.cwd());
              store.ingest(history).then((result) => {
                if (result && result.added > 0) {
                  process.stdout.write(`\n🌙 Dream Mode: +${result.added} insights saved to memory.\n`);
                }
              }).catch(() => {});
            }).catch(() => {});
          }
          // Trigger notification
          if (extra.notification !== undefined && extra.notification !== false) {
            const notifVal = extra.notification;
            import('../notification.js').then(({ triggerNotification }) => {
              triggerNotification(notifVal).catch(() => {});
            }).catch(() => {});
          }
          unmount();
          resolve();
        },
      }),
      { exitOnCtrlC: false }, // We handle Ctrl+C ourselves
    );

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      const history = agent.getHistory();
      if (history.length >= 2) {
        import('../../core/memory/session-snapshot.js').then(({ saveSnapshot }) => {
          try { saveSnapshot(`session-${SESSION_ID}`, history); } catch { /* non-fatal */ }
        }).catch(() => {});
      }
      // Dream mode on Ctrl+C too
      if (history.length >= 4) {
        import('../../core/memory/memory-store.js').then(({ getMemoryStore }) => {
          getMemoryStore(process.cwd()).ingest(history).then((result: { added?: number }) => {
            if (result && (result.added ?? 0) > 0) {
              process.stdout.write(`\n🌙 Dream Mode: +${result.added ?? 0} insights saved to memory.\n`);
            }
          }).catch(() => {});
        }).catch(() => {});
      }
      unmount();
      process.stdout.write('\n');
      resolve();
    });
  });
}
