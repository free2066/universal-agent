/**
 * App.tsx — Root Ink component for the universal-agent REPL.
 *
 * Manages global state:
 * - Chat messages (displayed in MessageList)
 * - Active tool calls (displayed as ToolCallLine)
 * - Streaming state
 * - Status bar values
 *
 * Delegates input handling to PromptInput.
 * Wires agent.runStream() to React state updates.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { MessageList, type ChatMessage } from './MessageList.js';
import { PromptInput } from './PromptInput.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import { ToolCallLine, type ToolCallInfo } from './ToolCallLine.js';
import type { AgentCore } from '../../core/agent.js';
import { HookRunner } from '../../core/hooks.js';
import { modelManager } from '../../models/model-manager.js';
import { SessionLogger } from '../session-logger.js';

const SLASH_COMPLETIONS = [
  '/help', '/clear', '/exit', '/resume', '/compact', '/tokens', '/cost',
  '/model', '/models', '/domain', '/continue',
  '/review', '/inspect', '/purify',
  '/spec', '/spec:brainstorm', '/spec:write-plan', '/spec:execute-plan',
  '/agents', '/team', '/tasks', '/inbox',
  '/image', '/history', '/hooks', '/insights', '/init', '/rules', '/memory',
  '/mcp', '/log', '/logs',
  '/context', '/status', '/copy', '/export',
  '/branch', '/rename', '/add-dir',
  '/terminal-setup', '/bug', '/output-style',
  '/skills', '/plugin', '/logout',
  '/metrics', '/plugins',
];

export interface AppProps {
  agent: AgentCore;
  domain: string;
  verbose?: boolean;
  sessionId: string;
  modelDisplayName: string;
  contextLength?: number;
  onExit?: () => void;
  initialPrompt?: string;
  inferProviderEnvKey?: (msg: string) => string | undefined;
  /** Shown once at startup if a previous session is available */
  startupHint?: string;
  /** Called on mount with an abort function that cancels any active stream.
   *  Allows launch.ts SIGINT handler to gracefully abort before unmounting.
   *  (readline parity: repl.ts _currentAbort?.abort() before exit) */
  onRegisterAbort?: (abortFn: () => void) => void;
}

export function App({
  agent,
  domain: initialDomain,
  verbose: initialVerbose,
  sessionId,
  modelDisplayName,
  contextLength = 128000,
  onExit,
  initialPrompt,
  inferProviderEnvKey,
  startupHint,
  onRegisterAbort,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const hookRunner = useRef(new HookRunner(process.cwd()));

  // ── State ─────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [domain, setDomain] = useState(initialDomain);
  const [mode, setMode] = useState<'default' | 'plan' | 'brainstorm' | 'auto-edit'>('default');
  // Tracks model display name after /model <name> switches (readline parity: updateStatusBar after model change)
  const [currentModelDisplay, setCurrentModelDisplay] = useState<string | undefined>(undefined);
  const [verbose, setVerbose] = useState(initialVerbose ?? false);
  const [statusInfo, setStatusInfo] = useState<Omit<StatusBarProps, 'model' | 'domain' | 'sessionId'>>({
    isThinking: 'none',
    estimatedTokens: 0,
    contextLength,
  });

  const abortRef = useRef<AbortController | null>(null);
  const toolSeqRef = useRef(0);
  const toolStartRef = useRef<Map<string, number>>(new Map());
  const isSubmittingRef = useRef(false); // debounce guard

  // ── Thinking level cycle (Ctrl+T) ────────────────────────────────────────
  const THINKING_CYCLE = [undefined, 'low', 'medium', 'high'] as const;
  type ThinkingLevel = typeof THINKING_CYCLE[number];
  const thinkingIdxRef = useRef(0);

  // ── Agent mode cycle (Shift+Tab) ─────────────────────────────────────────
  const AGENT_MODES = ['default', 'plan', 'brainstorm', 'auto-edit'] as const;
  const modeIdxRef = useRef(0);
  const MODE_PROMPTS: Record<string, string> = {
    'default': '',
    'plan': 'You are in PLAN mode. Think step by step and produce a detailed plan before taking any action. Do NOT edit files directly.',
    'brainstorm': 'You are in BRAINSTORM mode. Generate creative ideas and explore multiple approaches freely.',
    'auto-edit': 'You are in AUTO-EDIT mode. Apply code edits directly and immediately without asking for confirmation.',
  };

  // ── Esc×2 rollback timer ─────────────────────────────────────────────────
  const lastEscRef = useRef(0);

  // ── Current prompt value ref (for Ctrl+G editor pre-population) ──────────
  // Updated by PromptInput's onChange; allows Ctrl+G to pre-fill editor with
  // the user's in-progress input (readline parity: writes rl.line into tmpFile)
  const currentPromptRef = useRef<string>('');
  // External value to inject back into PromptInput after Ctrl+G editing
  // (readline parity: repl.ts sets rl.line and calls rl.prompt() so user can
  // review/edit the content before hitting Enter to submit)
  const [externalPromptValue, setExternalPromptValue] = useState<string | undefined>(undefined);

  // ── Ctrl+L double-press timer ────────────────────────────────────────────
  const lastCtrlLRef = useRef(0);

  // ── Ctrl+R reverse-search state ─────────────────────────────────────────
  const [historySearch, setHistorySearch] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const historySearchIdxRef = useRef(-1);
  const [historySearchMatch, setHistorySearchMatch] = useState<string | null>(null);

  // Shared helper: resolve search match
  const findHistoryMatch = useCallback((query: string, fromIdx: number, history: string[]): { match: string | null; idx: number } => {
    const rev = [...history].reverse();
    const sliced = rev.slice(fromIdx);
    const ni = sliced.findIndex((h) => h.includes(query));
    if (ni === -1) return { match: null, idx: -1 };
    return { match: sliced[ni]!, idx: fromIdx + ni };
  }, []);

  // ── Real SessionLogger (created once per session) ──────────────────────
  const sessionLogger = useRef<SessionLogger>(
    new SessionLogger({
      sessionId,
      model: modelDisplayName || modelManager.getCurrentModel('main'),
      domain: initialDomain,
    })
  );

  // ── Helper: append message ──────────────────────────────────────────────
  const appendMessage = useCallback((role: ChatMessage['role'], text: string) => {
    if (!text.trim()) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === role && role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role, content: text, timestamp: new Date().toISOString() }];
    });
  }, []);

  const appendAssistant = useCallback((text: string) => appendMessage('assistant', text), [appendMessage]);
  const appendSystem = useCallback((text: string) => appendMessage('system', text), [appendMessage]);

  // ── Slash command handler — real implementations, no console.log capture ──
  const handleSlashCommand = useCallback(async (input: string) => {
    const cmd = input.trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[1];

    // ── /exit /quit ─────────────────────────────────────────────────────────
    if (cmd === '/exit' || cmd === '/quit') {
      await hookRunner.current.run({ event: 'on_session_end', cwd: process.cwd() }).catch(() => {});
      const h = agent.getHistory();
      if (h.length >= 2) {
        try {
          const { saveSnapshot } = await import('../../core/memory/session-snapshot.js');
          saveSnapshot(sessionId, h);
        } catch { /* non-fatal */ }
      }
      // Dream Mode: ingest session insights on clean /exit (readline parity:
      // rl.on('close') calls getMemoryStore().ingest() when history.length >= 4)
      if (h.length >= 4) {
        try {
          const { getMemoryStore } = await import('../../core/memory/memory-store.js');
          const result = await getMemoryStore(process.cwd()).ingest(h);
          if (result && (result.added ?? 0) > 0) {
            appendSystem(`Dream Mode: +${result.added ?? 0} insights saved to memory.`);
          }
        } catch { /* non-fatal */ }
      }
      sessionLogger.current.close();
      onExit?.();
      exit();
      return;
    }

    // ── /clear ───────────────────────────────────────────────────────────────
    if (cmd === '/clear') {
      agent.clearHistory();
      setMessages([]);
      setToolCalls([]);
      return;
    }

    // ── /domain [name] ───────────────────────────────────────────────────────
    if (cmd.startsWith('/domain')) {
      if (sub) {
        agent.setDomain(sub);
        setDomain(sub);
        appendSystem(`Domain set to: ${sub}`);
      } else {
        appendSystem(`Current domain: ${domain}`);
      }
      return;
    }

    // ── /model [name] ────────────────────────────────────────────────────────
    if (cmd.startsWith('/model') && !cmd.startsWith('/models')) {
      if (sub) {
        agent.setModel(sub);
        modelManager.setPointer('main', sub);
        appendSystem(`Model switched to: ${sub}`);
      } else {
        const current = modelManager.getCurrentModel('main');
        const profiles = modelManager.listProfiles();
        const lines = ['Models (use /model <name> to switch):', ''];
        for (const p of profiles) {
          const active = p.name === current ? ' <- active' : '';
          const ctx2 = p.contextLength >= 1000000
            ? `${(p.contextLength / 1000000).toFixed(1)}M`
            : `${Math.round(p.contextLength / 1000)}k`;
          lines.push(`  ${p.name.padEnd(32)} [${p.provider.padEnd(12)}] ${ctx2}${active}`);
        }
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /models [switch <name>] ──────────────────────────────────────────────
    if (cmd.startsWith('/models')) {
      if (sub === 'switch' && parts[2]) {
        agent.setModel(parts[2]);
        modelManager.setPointer('main', parts[2]);
        appendSystem(`Model switched to: ${parts[2]}`);
      } else {
        const profiles = modelManager.listProfiles();
        const pointers = modelManager.getPointers();
        const lines = ['Available models:', ''];
        lines.push(`  ${'NAME'.padEnd(32)} ${'PROVIDER'.padEnd(14)} ${'CONTEXT'.padEnd(10)} POINTER`);
        lines.push('  ' + '─'.repeat(65));
        for (const p of profiles) {
          const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
          const ctx2 = p.contextLength >= 1000000
            ? `${(p.contextLength / 1000000).toFixed(1)}M`
            : `${Math.round(p.contextLength / 1000)}k`;
          lines.push(`  ${(role ? '● ' : '○ ') + p.name.padEnd(30)} ${p.provider.padEnd(14)} ${ctx2.padEnd(10)} ${role ? `[${role}]` : ''}`);
        }
        lines.push('');
        lines.push('  /models switch <name>  — switch main model');
        lines.push('  uagent models add       — add custom model');
        lines.push('  uagent models set <ptr> <model>  — set pointer');
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /log ────────────────────────────────────────────────────────────────
    if (cmd === '/log') {
      const logPath = sessionLogger.current.path;
      appendSystem([
        'Current session log:',
        `  ${logPath}`,
        `  To share with AI: cat "${logPath}" | pbcopy`,
      ].join('\n'));
      return;
    }

    // ── /logs ───────────────────────────────────────────────────────────────
    if (cmd === '/logs') {
      const { listLogs } = await import('../session-logger.js');
      const logs = listLogs();
      if (!logs.length) {
        appendSystem('No session logs found.');
      } else {
        const lines = ['Recent session logs (newest first):', ''];
        for (const [i, l] of logs.entries()) {
          const kb = (l.size / 1024).toFixed(1);
          const age = l.mtime ? new Date(l.mtime).toLocaleString('zh-CN', { hour12: false }) : '';
          const marker = i === 0 ? ' <- latest' : '';
          lines.push(`  ${String(i + 1).padStart(2)}.  ${l.name}  ${kb}KB  ${age}${marker}`);
        }
        lines.push('');
        lines.push(`  To copy latest: cat "${logs[0]?.path}" | pbcopy`);
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /status ─────────────────────────────────────────────────────────────
    if (cmd === '/status') {
      const currentModel = modelManager.getCurrentModel('main');
      const h = agent.getHistory();
      let version = '(unknown)';
      try {
        const { readFileSync } = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
        version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? version;
      } catch { /* */ }
      appendSystem([
        'Status:',
        `  Version  : v${version}`,
        `  CWD      : ${process.cwd()}`,
        `  Model    : ${currentModel}`,
        `  Domain   : ${domain}`,
        `  Session  : ${sessionId}`,
        `  Messages : ${h.length}`,
        `  Log      : ${sessionLogger.current.path}`,
        '',
        '  /model — switch model  |  /log — session log path',
      ].join('\n'));
      return;
    }

    // ── /tokens /context ────────────────────────────────────────────────────
    if (cmd === '/tokens' || cmd === '/context') {
      const { shouldCompact } = await import('../../core/context/context-compressor.js');
      const history = agent.getHistory();
      const decision = shouldCompact(history);
      const pct = ((decision.estimatedTokens / decision.contextLength) * 100).toFixed(1);
      appendSystem([
        'Context Usage:',
        `  Estimated tokens : ${decision.estimatedTokens.toLocaleString()}`,
        `  Context limit    : ${decision.contextLength.toLocaleString()}`,
        `  Usage            : ${pct}%  (threshold: ${(decision.threshold / decision.contextLength * 100).toFixed(0)}%)`,
        `  Turns in history : ${history.length}`,
        `  Compact needed   : ${decision.shouldCompact ? 'Yes' : 'No'}`,
        '',
        '  Run /compact to manually compress now.',
      ].join('\n'));
      return;
    }

    // ── /compact ────────────────────────────────────────────────────────────
    if (cmd === '/compact') {
      const history = agent.getHistory();
      if (history.length <= 2) {
        appendSystem('History too short to compact (<=2 turns).');
        return;
      }
      appendSystem('Compacting context...');
      try {
        const origEnv = process.env.AGENT_COMPACT_THRESHOLD;
        process.env.AGENT_COMPACT_THRESHOLD = '0.0001';
        // Calculate stats before compaction for informative output
        // (readline parity: ora spinner shows "Compacting N turns (P% context)...")
        const { estimateHistoryTokens, shouldCompact } = await import('../../core/context/context-compressor.js');
        const decision = shouldCompact(history);
        const pct = ((decision.estimatedTokens / decision.contextLength) * 100).toFixed(1);
        appendSystem(`Compacting ${history.length} turns (${pct}% context)...`);
        try {
          const { getMemoryStore } = await import('../../core/memory/memory-store.js');
          const store = getMemoryStore(process.cwd());
          const result = await store.ingest(history);
          agent.clearHistory();
          setMessages([]);
          appendSystem(`Compacted ${history.length} turns. Insights saved (+${result.added} memories). History cleared.`);
        } finally {
          if (origEnv === undefined) delete process.env.AGENT_COMPACT_THRESHOLD;
          else process.env.AGENT_COMPACT_THRESHOLD = origEnv;
        }
      } catch (err) {
        appendSystem(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /continue ────────────────────────────────────────────────────────────
    // Matches readline handleContinue: inject "continue" instruction into agent
    if (cmd === '/continue') {
      const continuePrompt = '[SYSTEM] Continue from where you left off — complete any remaining tasks.';
      appendSystem('Sending continue instruction to agent...');
      try {
        let out = '';
        await agent.runStream(continuePrompt, (c) => { out += c; appendAssistant(c); });
        if (!out) appendSystem('(agent had nothing more to continue)');
      } catch (err) {
        appendSystem(`Continue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /resume [session-id] ─────────────────────────────────────────────────
    if (cmd.startsWith('/resume')) {
      const { loadSnapshot, loadLastSnapshot } = await import('../../core/memory/session-snapshot.js');
      const formatAge = (ts: number) => {
        const diff = Date.now() - ts;
        if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
        if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
        return `${Math.round(diff / 3600000)}h ago`;
      };
      if (sub) {
        const snap = loadSnapshot(sub);
        if (snap && snap.messages.length >= 2) {
          agent.setHistory(snap.messages as never);
          // Restore messages in UI
          const { getContentText } = await import('../../models/types.js');
          const restored: ChatMessage[] = snap.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: getContentText(m.content),
              timestamp: new Date().toISOString(),
            }));
          setMessages(restored);
          appendSystem(`Restored session "${sub}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`);
        } else {
          // Session not found: list available sessions (readline parity)
          try {
            const { readdirSync, statSync: ss, existsSync: es } = await import('fs');
            const { resolve: r2, join: j2 } = await import('path');
            const sessDir = r2(process.env.HOME ?? '~', '.uagent', 'sessions');
            if (es(sessDir)) {
              const files = readdirSync(sessDir)
                .filter((f) => f.endsWith('.json'))
                .sort((a, b) => ss(j2(sessDir, b)).mtimeMs - ss(j2(sessDir, a)).mtimeMs)
                .slice(0, 10);
              if (files.length > 0) {
                const lines = [`Session "${sub}" not found. Available sessions:`, ''];
                files.forEach((f, i) => {
                  const id = f.replace('.json', '');
                  const mtime = ss(j2(sessDir, f)).mtimeMs;
                  lines.push(`  ${String(i + 1).padStart(2)}.  ${id}  (${formatAge(mtime)})`);
                });
                lines.push('', '  Use: /resume <session-id>');
                appendSystem(lines.join('\n'));
              } else {
                appendSystem(`Session "${sub}" not found. No saved sessions available.`);
              }
            } else {
              appendSystem(`Session "${sub}" not found.`);
            }
          } catch {
            appendSystem(`Session "${sub}" not found.`);
          }
        }
      } else {
        const snap = loadLastSnapshot();
        if (snap && snap.messages.length >= 2) {
          agent.setHistory(snap.messages as never);
          const { getContentText } = await import('../../models/types.js');
          const restored: ChatMessage[] = snap.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: getContentText(m.content),
              timestamp: new Date().toISOString(),
            }));
          setMessages(restored);
          appendSystem(`Restored last session from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`);
        } else {
          // No last snapshot: list available sessions
          try {
            const { readdirSync, statSync: ss2, existsSync: es2 } = await import('fs');
            const { resolve: r3, join: j3 } = await import('path');
            const sessDir2 = r3(process.env.HOME ?? '~', '.uagent', 'sessions');
            if (es2(sessDir2)) {
              const files2 = readdirSync(sessDir2)
                .filter((f) => f.endsWith('.json'))
                .sort((a, b) => ss2(j3(sessDir2, b)).mtimeMs - ss2(j3(sessDir2, a)).mtimeMs)
                .slice(0, 10);
              if (files2.length > 0) {
                const lines2 = ['No last session. Available sessions:', ''];
                files2.forEach((f, i) => {
                  const id = f.replace('.json', '');
                  const mtime = ss2(j3(sessDir2, f)).mtimeMs;
                  lines2.push(`  ${String(i + 1).padStart(2)}.  ${id}  (${formatAge(mtime)})`);
                });
                lines2.push('', '  Use: /resume <session-id>');
                appendSystem(lines2.join('\n'));
              } else {
                appendSystem('No saved sessions found.');
              }
            } else {
              appendSystem('No saved sessions found.');
            }
          } catch {
            appendSystem('No saved session found.');
          }
        }
      }
      return;
    }

    // ── /branch ──────────────────────────────────────────────────────────────
    if (cmd === '/branch') {
      const { saveSnapshot } = await import('../../core/memory/session-snapshot.js');
      const history = agent.getHistory();
      const branchId = `branch-${Date.now()}`;
      saveSnapshot(branchId, history);
      appendSystem(`Branched session saved as: ${branchId}\nUse /resume to restore this session later.\nCurrent session continues unchanged.`);
      return;
    }

    // ── /rename <name> ───────────────────────────────────────────────────────
    if (cmd.startsWith('/rename ')) {
      const { saveSnapshot } = await import('../../core/memory/session-snapshot.js');
      const newName = cmd.slice('/rename '.length).trim();
      if (!newName) { appendSystem('Usage: /rename <session-name>'); return; }
      const history = agent.getHistory();
      saveSnapshot(`named-${newName}`, history);
      appendSystem(`Session renamed to: ${newName}`);
      return;
    }

    // ── /copy ────────────────────────────────────────────────────────────────
    if (cmd === '/copy') {
      const history = agent.getHistory();
      const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
      if (!lastAssistant) { appendSystem('No AI reply to copy yet.'); return; }
      const { getContentText } = await import('../../models/types.js');
      const text = getContentText(lastAssistant.content);
      try {
        const { execSync } = await import('child_process');
        const clipCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
        execSync(clipCmd, { input: text });
        appendSystem(`Copied ${text.length} chars to clipboard.`);
      } catch {
        appendSystem(`Clipboard unavailable. Last reply:\n${text.slice(0, 500)}${text.length > 500 ? '\n...(truncated)' : ''}`);
      }
      return;
    }

    // ── /export [dir] ────────────────────────────────────────────────────────
    if (cmd.startsWith('/export')) {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const outDir = sub || process.cwd();
      const filename = `uagent-session-${sessionId.slice(0, 8)}-${Date.now()}.md`;
      const outPath = join(outDir, filename);
      const history = agent.getHistory();
      const { getContentText } = await import('../../models/types.js');
      const lines = [`# Session Export — ${new Date().toLocaleString()}\n`];
      for (const msg of history) {
        const icon = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : `**${msg.role}**`;
        lines.push(`### ${icon}\n\n${getContentText(msg.content)}\n`);
      }
      try {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, lines.join('\n---\n\n'), 'utf-8');
        appendSystem(`Session exported to: ${outPath}`);
      } catch (err) {
        appendSystem(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /memory ──────────────────────────────────────────────────────────────
    if (cmd.startsWith('/memory')) {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      if (!sub) {
        const stats = store.stats();
        appendSystem([
          'Memory Stats:',
          `  Pinned  : ${stats.pinned}`,
          `  Insight : ${stats.insight}`,
          `  Fact    : ${stats.fact}`,
          '',
          '  /memory pin <text>  — pin a memory',
          '  /memory list        — list all memories',
          '  /memory forget      — clear all memories',
          '  /memory ingest      — extract insights from this session',
        ].join('\n'));
      } else if (sub === 'pin') {
        const text = parts.slice(2).join(' ');
        if (!text) { appendSystem('Usage: /memory pin <text>'); return; }
        const id = store.add({ type: 'pinned', content: text, tags: [], source: 'user' });
        appendSystem(`Pinned [${id}]: ${text}`);
      } else if (sub === 'list') {
        const items = store.list();
        if (!items.length) { appendSystem('No memories yet.'); return; }
        const lines = ['All memories:', ''];
        for (const m of items) {
          lines.push(`  [${m.type}] ${m.id}  ${m.content.slice(0, 100)}`);
          if (m.tags.length) lines.push(`    tags: ${m.tags.join(', ')}`);
        }
        appendSystem(lines.join('\n'));
      } else if (sub === 'forget') {
        store.clear();
        appendSystem('All memories cleared for this project.');
      } else if (sub === 'ingest') {
        appendSystem('Running memory ingest...');
        try {
          const result = await store.ingest(agent.getHistory());
          appendSystem(`Ingest complete: +${result.added} added, ~${result.updated} updated, ${result.skipped} skipped`);
        } catch (e) {
          appendSystem(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }

    // ── /history [n] ─────────────────────────────────────────────────────────
    if (cmd.startsWith('/history')) {
      const n = parseInt(sub || '10', 10);
      const { getRecentHistory } = await import('../../core/memory/session-history.js');
      const entries = getRecentHistory(isNaN(n) ? 10 : n);
      if (!entries.length) { appendSystem('(no history)'); return; }
      const lines = [`Recent ${entries.length} prompts:`, ''];
      entries.forEach((e, i) => {
        lines.push(`  ${String(i + 1).padStart(3)}.  ${e.slice(0, 120)}${e.length > 120 ? '…' : ''}`);
      });
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /tasks ───────────────────────────────────────────────────────────────
    if (cmd === '/tasks') {
      const { getTaskBoard } = await import('../../core/task-board.js');
      const result = getTaskBoard(process.cwd()).listAll();
      appendSystem(result || 'No tasks.');
      return;
    }

    // ── /agents [clean [days]] ───────────────────────────────────────────────
    if (cmd.startsWith('/agents')) {
      const { subagentSystem } = await import('../../core/subagent-system.js');
      if (cmd.startsWith('/agents clean')) {
        const staleDays = parseInt(parts[2] || '30', 10);
        const zombies = subagentSystem.findZombieAgents(isNaN(staleDays) ? 30 : staleDays);
        if (!zombies.length) {
          appendSystem(`No stale subagents found (threshold: ${staleDays} days)`);
        } else {
          const lines = [`Stale subagents (unused >${staleDays} days):`, ''];
          for (const z of zombies) {
            const lastStr = z.lastUsed ? z.lastUsed.toLocaleDateString() : 'never used';
            lines.push(`  ${z.name.padEnd(20)} last: ${lastStr}, calls: ${z.callCount}`);
          }
          lines.push('', '  Tip: remove unused .uagent/agents/<name>.md files to clean up');
          appendSystem(lines.join('\n'));
        }
      } else {
        const agents = subagentSystem.listAgents();
        if (!agents.length) { appendSystem('No subagents defined.'); return; }
        const lines = ['Subagents:', ''];
        for (const a of agents) {
          lines.push(`  @run-agent-${a.name.padEnd(18)} ${a.description}`);
        }
        lines.push('', '  Tip: /agents clean [days] — show stale subagents');
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /team ────────────────────────────────────────────────────────────────
    if (cmd === '/team') {
      const { getTeammateManager } = await import('../../core/teammate-manager.js');
      const result = getTeammateManager(process.cwd()).listAll();
      appendSystem(result || 'No active teammates.');
      return;
    }

    // ── /inbox ───────────────────────────────────────────────────────────────
    if (cmd === '/inbox') {
      const { getTeammateManager } = await import('../../core/teammate-manager.js');
      const msgs = getTeammateManager(process.cwd()).bus.readInbox('lead');
      appendSystem(msgs.length > 0 ? JSON.stringify(msgs, null, 2) : '(inbox empty)');
      return;
    }

    // ── /mcp ─────────────────────────────────────────────────────────────────
    if (cmd === '/mcp') {
      const { servers, tools } = agent.getMcpInfo();
      if (!servers.length) {
        appendSystem('No MCP servers configured.\n  Run: uagent mcp add -- npx -y <server-package>\n  Or:  uagent mcp init --templates  # scaffold with example configs');
      } else {
        const lines = ['MCP Servers:', ''];
        for (const s of servers) {
          const status = s.enabled ? 'enabled ' : 'disabled';
          const detail = s.type === 'stdio'
            ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
            : s.url ?? '';
          lines.push(`  [${status}] ${s.name.padEnd(20)} [${s.type ?? 'stdio'}]  ${detail}`);
        }
        if (tools.length > 0) {
          lines.push('', 'Active MCP tools:', '');
          for (const t of tools) lines.push(`  ${t}`);
        } else {
          // (readline parity: tool-handlers.ts no-tools hint)
          lines.push('', '  (No MCP tools connected this session — servers connect at startup)');
        }
        // Operation hints (readline parity: tool-handlers.ts handleMcp appends these)
        lines.push('');
        lines.push('  uagent mcp list      — show all configured servers');
        lines.push('  uagent mcp add       — add a server');
        lines.push('  uagent mcp disable   — disable without removing');
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /init ────────────────────────────────────────────────────────────────
    if (cmd === '/init') {
      const { initAgentsMd } = await import('../../core/context/context-loader.js');
      appendSystem(initAgentsMd(process.cwd()));
      return;
    }

    // ── /rules ───────────────────────────────────────────────────────────────
    if (cmd === '/rules') {
      const { loadRules } = await import('../../core/context/context-loader.js');
      const rules = loadRules(process.cwd());
      if (!rules.sources.length) {
        appendSystem('No rules loaded. Create .uagent/rules/*.md to define coding standards.');
      } else {
        const lines = ['Loaded rules (injected into every system prompt):', ''];
        for (const src of rules.sources) lines.push(`  ${src}`);
        lines.push('', '  Tip: Add .uagent/rules/coding.md, api-style.md, etc.');
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /skills ───────────────────────────────────────────────────────────────
    if (cmd === '/skills') {
      const { readdirSync, statSync, existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const searchDirs = [
        { label: 'project (.uagent/commands/)', dir: join(process.cwd(), '.uagent', 'commands') },
        { label: 'global (~/.uagent/commands/)', dir: join(process.env.HOME ?? '~', '.uagent', 'commands') },
      ];
      let totalCount = 0;
      const lines = ['Installed Skills (custom slash commands):', ''];
      for (const { label, dir } of searchDirs) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
        if (!files.length) continue;
        lines.push(`  ${label}`);
        for (const f of files) {
          const cmdName = '/' + f.replace(/\.md$/, '');
          let description = '';
          try {
            const raw = readFileSync(join(dir, f), 'utf-8');
            const match = raw.match(/^description:\s*(.+)$/m);
            description = match ? match[1]!.trim() : raw.replace(/^---[\s\S]*?---\n/, '').split('\n').filter((l) => l.trim())[0]?.slice(0, 80) ?? '';
          } catch { /* */ }
          const mtime = statSync(join(dir, f)).mtimeMs;
          const ago = Math.floor((Date.now() - mtime) / (1000 * 60 * 60 * 24));
          lines.push(`    ${cmdName.padEnd(24)} ${ago === 0 ? 'today' : `${ago}d ago`}  ${description}`);
          totalCount++;
        }
      }
      if (!totalCount) {
        lines.push('  No custom skills found.');
        lines.push('  Create .uagent/commands/<name>.md to add a skill');
        lines.push('  Example: .uagent/commands/summarize.md');
        lines.push('  Content: "Summarize the following: $ARGUMENTS"');
      } else {
        lines.push('', `  Total: ${totalCount} skill(s) installed`);
        lines.push('  Use: /<skill-name> [arguments]  — run a skill directly as a slash command');
      }
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /metrics ─────────────────────────────────────────────────────────────
    if (cmd === '/metrics') {
      const { sessionMetrics } = await import('../../core/metrics.js');
      appendSystem('LLM Call Metrics (this session):\n\n' + sessionMetrics.getSummary());
      return;
    }

    // ── /plugins ─────────────────────────────────────────────────────────────
    if (cmd === '/plugins') {
      const { listRegisteredPlugins, getPluginSlashCommands } = await import('../../core/domain-router.js');
      const plugins = listRegisteredPlugins();
      const lines = ['Domain Plugins:', ''];
      lines.push(`  ${'NAME'.padEnd(14)} ${'SOURCE'.padEnd(10)} DESCRIPTION`);
      lines.push('  ' + '-'.repeat(60));
      for (const p of plugins) {
        const src = p.source === 'builtin' ? 'builtin' : 'external';
        const desc = p.plugin.description.slice(0, 40) + (p.plugin.description.length > 40 ? '...' : '');
        const slashCount = p.plugin.slashCommands?.length ? ` +${p.plugin.slashCommands.length} slash` : '';
        const hookCount = p.plugin.hooks?.length ? ` +${p.plugin.hooks.length} hooks` : '';
        lines.push(`  ${p.name.padEnd(14)} ${src.padEnd(10)} ${desc} (${p.plugin.tools.length} tools)${slashCount}${hookCount}`);
      }
      const cmds = getPluginSlashCommands();
      if (cmds.size > 0) {
        lines.push('', 'Plugin Slash Commands:');
        for (const [c, def] of cmds) lines.push(`  ${c.padEnd(20)} ${def.description}`);
      }
      // Plugin Hooks (readline parity: tool-handlers.ts handleDomainPlugins lists hooks by event)
      const { getPluginHooks } = await import('../../core/domain-router.js');
      const allHookEvents = ['pre_prompt', 'post_response', 'on_tool_call', 'on_session_end'] as const;
      const hookLines: string[] = [];
      for (const ev of allHookEvents) {
        const hooks = getPluginHooks(ev);
        for (const h of hooks) {
          hookLines.push(`  ${ev.padEnd(20)} ${(h as { pluginName?: string }).pluginName ?? '?'} — ${(h as { description?: string }).description ?? '(no description)'}`);
        }
      }
      if (hookLines.length > 0) {
        lines.push('', 'Plugin Hooks:');
        hookLines.forEach((l) => lines.push(l));
      }
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /bug ─────────────────────────────────────────────────────────────────
    if (cmd.startsWith('/bug')) {
      const desc = cmd.slice('/bug'.length).trim();
      const logPath = sessionLogger.current.path;
      appendSystem([
        'Bug Report',
        `  Session log  : ${logPath}`,
        `  Working dir  : ${process.cwd()}`,
        `  Model        : ${modelManager.getCurrentModel('main')}`,
        `  Session      : ${sessionId}`,
        ...(desc ? [`  Description  : ${desc}`] : []),
        '',
        '  Steps to report:',
        `  1. cat "${logPath}" | pbcopy`,
        '  2. Open issue tracker',
        '  3. Paste log and describe the problem',
      ].join('\n'));
      return;
    }

    // ── /inspect [path] ──────────────────────────────────────────────────────
    if (cmd.startsWith('/inspect')) {
      appendSystem('Running code inspection...');
      try {
        const { codeInspectorTool } = await import('../../core/tools/code/code-inspector.js');
        const result = await codeInspectorTool.handler({
          path: sub || process.cwd(), severity: 'warning', verbose: false, format: 'report',
        });
        appendSystem(String(result));
      } catch (err) {
        appendSystem(`Inspect error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /review ──────────────────────────────────────────────────────────────
    if (cmd === '/review') {
      appendSystem('Running AI code review...');
      try {
        const { reviewCode } = await import('../../core/tools/code/ai-reviewer.js');
        const report = await reviewCode({ projectRoot: process.cwd() });
        appendSystem(report.markdown + `\n\nP1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}`);
      } catch (err) {
        appendSystem(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /spec [description] ──────────────────────────────────────────────────
    if (cmd.startsWith('/spec:brainstorm ')) {
      const topic = cmd.slice('/spec:brainstorm '.length).trim();
      if (!topic) { appendSystem('Usage: /spec:brainstorm <topic>'); return; }
      appendSystem('Brainstorming...');
      try {
        const prompt = `# Brainstorm: ${topic}\n\nPlease brainstorm design approaches for:\n\n**Topic:** ${topic}\n\nProvide: 3-5 approaches, pros/cons, key challenges, recommended starting point.`;
        let out = '';
        await agent.runStream(prompt, (c) => { out += c; });
        appendSystem(out);
      } catch (err) {
        appendSystem(`Brainstorm failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (cmd.startsWith('/spec')) {
      const desc = cmd.slice('/spec'.length).trim();
      if (!desc) {
        const { listSpecs } = await import('../../core/tools/code/spec-generator.js');
        const specs = listSpecs(process.cwd());
        if (!specs.length) {
          appendSystem('No specs yet. Usage: /spec <requirement description>');
        } else {
          const lines = ['Specs:', ''];
          specs.forEach((s, i) => lines.push(`  ${String(i + 1).padStart(2)}.  ${(s as { date?: string }).date ?? ''}  ${(s as { name?: string }).name ?? ''}` ));
          appendSystem(lines.join('\n'));
        }
      } else {
        appendSystem('Generating spec...');
        try {
          const { generateSpec } = await import('../../core/tools/code/spec-generator.js');
          const result = await generateSpec(desc, process.cwd());
          const lines: string[] = [`Spec saved: ${result.path}`, '', result.content];
          // ── Execution Plan: phases (readline parity) ──────────────────────
          if (result.phases && result.phases.length > 0) {
            lines.push('', 'Execution Plan (Phases):');
            for (const ph of result.phases) {
              const mode = ph.parallel ? 'parallel' : 'sequential';
              const deps = ph.dependsOn.length > 0 ? `  depends: Phase ${ph.dependsOn.join(', ')}` : '';
              lines.push(`  Phase ${ph.phase} [${mode}] ${ph.label}${deps}`);
              ph.tasks.forEach((t, ti) => lines.push(`    ${ti + 1}. ${t}`));
            }
          } else if ((result as unknown as { tasks?: string[] }).tasks?.length) {
            const tasks = (result as unknown as { tasks: string[] }).tasks;
            lines.push('', 'Tasks extracted:');
            tasks.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
          }
          appendSystem(lines.join('\n'));
        } catch (err) {
          appendSystem(`Spec failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    // ── /hooks [init|reload] ─────────────────────────────────────────────────
    if (cmd.startsWith('/hooks')) {
      const hookSub = cmd.slice('/hooks'.length).trim();
      // /hooks init — create .uagent/hooks.json with example config
      if (hookSub === 'init') {
        const { HookRunner } = await import('../../core/hooks.js');
        const msg = HookRunner.init(process.cwd());
        appendSystem(msg);
        return;
      }
      // /hooks reload — reload hooks config from disk
      if (hookSub === 'reload') {
        hookRunner.current.reload();
        const count = hookRunner.current.listHooks().length;
        appendSystem(`Hooks reloaded. ${count} hook(s) active.`);
        return;
      }
      // /hooks — list hooks
      const hooks = hookRunner.current.listHooks();
      if (!hooks.length) {
        appendSystem('No hooks configured. Create .uagent/hooks.json to add hooks.\n  Run /hooks init to create an example config.');
      } else {
        const lines = ['Lifecycle Hooks:', ''];
        for (const h of hooks) {
          const status = h.enabled !== false ? 'on ' : 'off';
          lines.push(`  [${status}] [${h.event.padEnd(15)}] ${(h.description ?? (h as { type?: string }).type ?? '').slice(0, 60)}`);
        }
        lines.push('', '  /hooks init — create example config  |  /hooks reload — reload from disk');
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /purify [--dry-run] [--commit] ───────────────────────────────────────
    if (cmd.startsWith('/purify')) {
      const isDryRun = cmd.includes('--dry-run') || cmd.includes('-d');
      const doCommit = cmd.includes('--commit');   // readline parity: --commit flag
      appendSystem('Running self-heal (purify)...');
      try {
        const { selfHealTool } = await import('../../core/tools/code/self-heal.js');
        const result = await selfHealTool.handler({
          path: process.cwd(), dry_run: isDryRun, severity: 'warning', commit: doCommit, max_fixes: 20,
        });
        appendSystem(String(result));
      } catch (err) {
        appendSystem(`Purify error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /image <path> ───────────────────────────────────────────────────────
    if (cmd.startsWith('/image')) {
      const imagePath = cmd.replace('/image', '').trim();
      if (!imagePath) {
        appendSystem('Usage: /image <path>\n  Attaches an image file to the next message (multimodal).');
        return;
      }
      const { resolve } = await import('path');
      const { readFileSync, existsSync } = await import('fs');
      const absPath = resolve(imagePath);
      if (!existsSync(absPath)) {
        appendSystem(`Image file not found: ${absPath}`);
        return;
      }
      try {
        const buf = readFileSync(absPath);
        const base64 = buf.toString('base64');
        const ext = absPath.split('.').pop()?.toLowerCase() ?? 'png';
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
        };
        const mimeType = mimeMap[ext] ?? 'image/png';
        // Store as data URL on agent for next message
        (agent as typeof agent & { _pendingImage?: { data: string; mimeType: string } })._pendingImage = {
          data: base64, mimeType,
        };
        appendSystem(`Image loaded: ${absPath} (${(buf.length / 1024).toFixed(1)}KB)\nType your question about it and press Enter.`);
      } catch (err) {
        appendSystem(`Failed to read image: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /logout ───────────────────────────────────────────────────────────────
    if (cmd === '/logout') {
      const keyEnvVars = [
        'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
        'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'WQ_API_KEY',
      ];
      const lines = ['API Key Configuration', ''];
      let anyFound = false;
      for (const envVar of keyEnvVars) {
        const val = process.env[envVar];
        if (val) {
          anyFound = true;
          const masked = val.length > 8
            ? val.slice(0, 4) + '*'.repeat(val.length - 8) + val.slice(-4)
            : '****';
          lines.push(`  ${envVar.padEnd(24)} [set]  ${masked}`);
        } else {
          lines.push(`  ${envVar.padEnd(24)} [not set]`);
        }
      }
      lines.push('');
      if (anyFound) {
        lines.push('To remove a key (logout):');
        lines.push('  unset OPENAI_API_KEY            # current shell only');
        lines.push('  # or remove from ~/.zshrc / ~/.bashrc / .env file');
        lines.push('');
        lines.push('To switch models/providers:');
        lines.push('  /model                           # interactive picker');
      } else {
        lines.push('No API keys found. uagent requires at least one API key.');
        lines.push('  Set one: export OPENAI_API_KEY=sk-...');
      }
      lines.push('');
      lines.push('Note: uagent uses API keys (not login sessions).');
      lines.push('      Keys are read from environment variables or .env file.');
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /plugin ───────────────────────────────────────────────────────────────
    if (cmd.startsWith('/plugin')) {
      const sub = cmd.replace('/plugin', '').trim();
      const { readdirSync: _rds2, existsSync: _es2, statSync: _ss2 } = await import('fs');
      const { join: _jn2 } = await import('path');
      const baseDir = _jn2(process.cwd(), '.uagent');
      const globalDir = _jn2(process.env.HOME ?? '~', '.uagent');
      const scanPluginDir = (dir: string, sub2: string) => {
        const full = _jn2(dir, sub2);
        if (!_es2(full)) return [] as Array<{ name: string; mtime: number; scope: string }>;
        try { return _rds2(full).map((f) => ({ name: f, mtime: _ss2(_jn2(full, f)).mtimeMs, scope: '' })); }
        catch { return [] as Array<{ name: string; mtime: number; scope: string }>; }
      };
      if (!sub || sub === 'list') {
        const lines = ['Local Extensions (Plugins):', ''];
        const sections = [
          { label: 'Custom Commands (skills)', type: 'commands' },
          { label: 'Subagents', type: 'agents' },
          { label: 'Hooks', type: 'hooks' },
        ];
        let found = false;
        for (const { label, type } of sections) {
          const items = [
            ...scanPluginDir(baseDir, type).map((f) => ({ ...f, scope: 'project' })),
            ...scanPluginDir(globalDir, type).map((f) => ({ ...f, scope: 'global' })),
          ];
          if (items.length === 0) continue;
          found = true;
          lines.push(`  ${label}:`);
          for (const item of items.slice(0, 10)) {
            const ago = Math.floor((Date.now() - item.mtime) / (1000 * 60 * 60 * 24));
            lines.push(`    ${item.name.padEnd(30)} (${item.scope}) ${ago === 0 ? 'today' : `${ago}d ago`}`);
          }
          if (items.length > 10) lines.push(`    ... and ${items.length - 10} more`);
          lines.push('');
        }
        if (!found) {
          lines.push('  No local extensions installed.');
          lines.push('');
        }
        lines.push('  Plugin types:');
        lines.push('    .uagent/commands/*.md — custom slash commands (skills)');
        lines.push('    .uagent/agents/*.md   — custom subagents');
        lines.push('    .uagent/hooks/*.json  — lifecycle hooks');
        appendSystem(lines.join('\n'));
      } else {
        appendSystem(`Unknown plugin subcommand: ${sub}\nUsage: /plugin [list]`);
      }
      return;
    }

    // ── /add-dir <path> ───────────────────────────────────────────────────────
    if (cmd.startsWith('/add-dir')) {
      const dirPath = cmd.replace('/add-dir', '').trim();
      const { readdirSync: _rds3, statSync: _ss3, existsSync: _es3 } = await import('fs');
      const { join: _jn3, relative: _rel } = await import('path');
      if (!dirPath || !_es3(dirPath)) {
        appendSystem(`Directory not found: ${dirPath || '(no path given)'}\nUsage: /add-dir <path>`);
        return;
      }
      const files: string[] = [];
      const scanAddDir = (d: string, depth = 0): void => {
        if (depth > 2 || files.length > 100) return;
        try {
          for (const f of _rds3(d)) {
            if (['node_modules', '.git', 'dist'].includes(f)) continue;
            const full = _jn3(d, f);
            try {
              if (_ss3(full).isDirectory()) scanAddDir(full, depth + 1);
              else files.push(_rel(process.cwd(), full));
            } catch { /* */ }
          }
        } catch { /* */ }
      };
      scanAddDir(dirPath);
      agent.injectContext(`[Added directory to context: ${dirPath}]\nFiles in this directory:\n${files.slice(0, 80).join('\n')}`);
      appendSystem(`Added ${dirPath} to context (${files.length} files indexed)`);
      return;
    }

    // ── /insights [days] ──────────────────────────────────────────────────────
    if (cmd.startsWith('/insights')) {
      const parts = cmd.split(/\s+/);
      const days = parseInt(parts.find((p) => /^\d+$/.test(p)) ?? '30', 10);
      appendSystem(`Analyzing last ${days} days of usage...`);
      try {
        const { runInsights } = await import('../insights.js');
        const report = await runInsights({ days, projectRoot: process.cwd() });
        const lines = report.markdown.split('\n');
        const condensed = lines.slice(0, 60).join('\n');
        const truncated = lines.length > 60
          ? `\n... (${lines.length - 60} more lines — full report saved to ~/.uagent/)`
          : '';
        appendSystem(condensed + truncated);
      } catch (err) {
        appendSystem(`Insights failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /output-style [style] ─────────────────────────────────────────────────
    if (cmd.startsWith('/output-style')) {
      const style = cmd.replace('/output-style', '').trim();
      const validStyles = ['plain', 'markdown', 'compact'];
      if (!style) {
        appendSystem(`Output Styles:\n  plain    — plain text, no markdown\n  markdown — full markdown (default)\n  compact  — concise output, minimal headers\n\nCurrently: markdown (default — all output rendered as markdown)\n\nUsage: /output-style <style>`);
        return;
      }
      if (!validStyles.includes(style)) {
        appendSystem(`Unknown style "${style}". Choose: ${validStyles.join(', ')}`);
        return;
      }
      agent.injectContext(`[Output style changed to: ${style}]\nFrom now on, format all responses as ${style}.`);
      appendSystem(`Output style → ${style}`);
      return;
    }

    // ── /terminal-setup ───────────────────────────────────────────────────────
    if (cmd === '/terminal-setup') {
      appendSystem([
        'Terminal Setup — Shift+Enter line break',
        '',
        'Option 1: iTerm2',
        '  Preferences → Profiles → Keys → Key Mappings',
        '  Add: Shift+Enter → Send Hex Code → 0x0a',
        '',
        'Option 2: VS Code integrated terminal',
        '  Add to keybindings.json:',
        '  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",',
        '    "args": { "text": "\\n" }, "when": "terminalFocus" }',
        '',
        'Option 3: ~/.inputrc (universal readline)',
        '  Add: "\\e[13;2u": "\\n"',
        '  Then run: bind -f ~/.inputrc',
        '',
        'Already supported in uagent: \\ + Enter (universal), Option+Enter (macOS)',
      ].join('\n'));
      return;
    }

    // ── /spec:write-plan [topic] ──────────────────────────────────────────────
    if (cmd.startsWith('/spec:write-plan')) {
      const topic = cmd.replace('/spec:write-plan', '').trim();
      const history = agent.getHistory();
      const recentContext = history.slice(-6).map((m) => {
        const c = typeof m.content === 'string' ? m.content : '[content]';
        return `${m.role}: ${c.slice(0, 200)}`;
      }).join('\n');
      const planPrompt = topic
        ? `Generate a detailed implementation plan for: ${topic}`
        : `Based on our recent conversation:\n\n${recentContext}\n\nGenerate a detailed, step-by-step implementation plan with:\n1. Clear phases and milestones\n2. Specific tasks for each phase\n3. Dependencies between tasks\n4. Estimated complexity\n5. Potential risks and mitigations`;
      setIsStreaming(true);
      setStatusInfo((s) => ({ ...s, isThinking: 'low' }));
      abortRef.current = new AbortController();
      let planOut = '';
      try {
        await agent.runStream(planPrompt, (chunk) => {
          planOut += chunk;
          appendAssistant(chunk);
        }, {}, undefined, abortRef.current.signal);
      } catch (err) {
        appendSystem(`Plan generation failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
      }
      return;
    }

    // ── /spec:execute-plan ────────────────────────────────────────────────────
    if (cmd === '/spec:execute-plan') {
      const history = agent.getHistory();
      const lastPlan = [...history].reverse().find((m) => {
        const t = typeof m.content === 'string' ? m.content : '';
        return m.role === 'assistant' && (t.includes('Phase') || t.includes('Step') || t.includes('Task'));
      });
      if (!lastPlan) {
        appendSystem('No plan found in context. Run /spec:write-plan first.');
        return;
      }
      const execPrompt = `Execute the implementation plan step by step. Start with Phase 1 / Step 1.\nFor each step:\n1. Explain what you're doing\n2. Implement it\n3. Verify it works\n4. Move to the next step\n\nBegin execution now.`;
      setIsStreaming(true);
      setStatusInfo((s) => ({ ...s, isThinking: 'low' }));
      abortRef.current = new AbortController();
      try {
        await agent.runStream(execPrompt, (chunk) => { appendAssistant(chunk); },
          {}, undefined, abortRef.current.signal);
      } catch (err) {
        appendSystem(`Plan execution failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
      }
      return;
    }

    // ── /cost ────────────────────────────────────────────────────────────────
    if (cmd === '/cost') {
      const { sessionMetrics } = await import('../../core/metrics.js');
      const stats = sessionMetrics.getStats();
      const lines = ['Cost Estimate (this session):', ''];
      lines.push(`  LLM calls    : ${stats.calls}`);
      lines.push(`  Input tokens : ${stats.totalInputTokens.toLocaleString()}`);
      lines.push(`  Output tokens: ${stats.totalOutputTokens.toLocaleString()}`);
      lines.push(`  Duration     : ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
      lines.push(`  Failed calls : ${stats.failedCalls}`);
      // Model-level cost summary (readline getCostSummary parity)
      try {
        lines.push('');
        lines.push(modelManager.getCostSummary());
      } catch { /* non-fatal */ }
      // Today's cross-session usage
      try {
        const { usageTracker } = await import('../../models/usage-tracker.js');
        const todayUsage = usageTracker.loadTodayUsage();
        lines.push('');
        lines.push('Today (all sessions):');
        lines.push(`  Input:    ${todayUsage.totalInputTokens.toLocaleString()} tokens`);
        lines.push(`  Output:   ${todayUsage.totalOutputTokens.toLocaleString()} tokens`);
        lines.push(`  Cost:     $${todayUsage.totalCostUSD.toFixed(4)} USD`);
        lines.push(`  Sessions: ${todayUsage.sessions}`);
        const check = usageTracker.checkLimits();
        if (check.status !== 'ok' && check.message) lines.push('', check.message);
      } catch { /* usageTracker optional */ }
      // Operation hints (readline parity: tool-handlers.ts handleCost appends these)
      lines.push('');
      lines.push('  uagent usage --days 7  — view usage history');
      lines.push('  uagent limits          — view/set daily spending limits');
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (cmd === '/help') {
      appendSystem([
        'Available commands:',
        '',
        '  Session:',
        '    /log             show session log path',
        '    /logs            list recent sessions',
        '    /status          show session info',
        '    /resume [id]     restore last (or specific) session',
        '    /branch          save a branch of current session',
        '    /rename <name>   save session with a name',
        '    /export [dir]    export conversation to markdown',
        '    /copy            copy last AI reply to clipboard',
        '    /bug [desc]      show bug report info',
        '    /clear           clear history and screen',
        '    /exit  /quit     exit',
        '',
        '  Model / Domain:',
        '    /model [name]    show or switch model',
        '    /models          list all models',
        '    /domain [name]   show or switch domain',
        '    /agents          list subagents',
        '    /logout          show API key status',
        '',
        '  Context:',
        '    /tokens          show token usage',
        '    /context         show context window stats',
        '    /compact         compress context to memory',
        '    /history [n]     show recent prompts (default 10)',
        '    /add-dir <path>  inject directory file list into context',
        '',
        '  Memory:',
        '    /memory          memory stats',
        '    /memory pin <t>  pin a memory',
        '    /memory list     list memories',
        '    /memory forget   clear memories',
        '    /memory ingest   extract insights from session',
        '    /insights [days] usage analysis report (default 30d)',
        '',
        '  Tools:',
        '    /tasks           task board',
        '    /mcp             MCP servers',
        '    /team            active teammates',
        '    /inbox           lead inbox',
        '    /skills          custom slash commands',
        '    /plugins         domain plugins',
        '    /plugin          local extensions (commands/agents/hooks)',
        '    /metrics         LLM call metrics',
        '    /cost            token cost estimate',
        '    /hooks           lifecycle hooks',
        '    /review          AI code review',
        '    /inspect [path]  code inspection',
        '    /purify          self-heal fixes',
        '    /spec [desc]     spec generation',
        '    /spec:brainstorm <topic>  brainstorm ideas',
        '    /spec:write-plan [topic]  generate implementation plan',
        '    /spec:execute-plan        execute last plan',
        '    /init            create .uagent/AGENTS.md',
        '    /rules           show loaded rules',
        '',
        '  Output:',
        '    /output-style [style]  plain|markdown|compact',
        '    /terminal-setup        Shift+Enter configuration guide',
        '',
        '  Input:',
        '    @file            attach file to message',
        '    !cmd             run shell command and inject output',
        '    /image <path>    attach image to next message',
        '    Esc              abort streaming',
        '    Up/Down          navigate history',
        '    Tab              autocomplete commands/@file',
        '    Ctrl+R           reverse history search',
        '    Ctrl+G           open $EDITOR to compose input',
        '    Ctrl+L           clear screen (double: toggle verbose)',
        '    Ctrl+T           cycle thinking level',
        '    Ctrl+V           paste image from clipboard',
        '    Shift+Tab        cycle agent mode',
        '    Esc×2            rollback last turn',
      ].join('\n'));
      return;
    }

    // ── Plugin-contributed slash commands ────────────────────────────────────
    // Matches readline handlers/index.ts lines 109-136
    if (cmd.startsWith('/')) {
      const { getPluginSlashCommands } = await import('../../core/domain-router.js');
      const pluginCmds = getPluginSlashCommands();
      const pluginCmdName = cmd.split(/\s+/)[0]!;          // e.g. '/standup'
      const pluginCmdArgs = cmd.slice(pluginCmdName.length).trim();
      const pluginCmd = pluginCmds.get(pluginCmdName);
      if (pluginCmd) {
        appendSystem(`Running plugin command: ${pluginCmdName}`);
        let out = '';
        try {
          await pluginCmd.handler(pluginCmdArgs, {
            onChunk: (c: string) => { out += c; },
            agentHistory: (agent as unknown as Record<string, unknown>).history as readonly unknown[] ?? [],
            cwd: process.cwd(),
          });
          appendSystem(out);
        } catch (err) {
          appendSystem(`Plugin command error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // ── Unknown command — try as skill file ───────────────────────────────────
    {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const cmdName = cmd.startsWith('/') ? cmd.slice(1).split(/\s+/)[0]! : '';
      const skillArgs = cmd.slice(cmdName.length + 1).trim();
      const skillDirs = [
        join(process.cwd(), '.uagent', 'commands', `${cmdName}.md`),
        join(process.env.HOME ?? '~', '.uagent', 'commands', `${cmdName}.md`),
      ];
      for (const skillPath of skillDirs) {
        if (existsSync(skillPath)) {
          const content = readFileSync(skillPath, 'utf-8').replace(/^---[\s\S]*?---\n/, '');
          const prompt = content.replace(/\$ARGUMENTS/g, skillArgs);
          appendSystem(`Running skill: /${cmdName}`);
          let out = '';
          await agent.runStream(prompt, (c) => { out += c; }).catch((e) => {
            out = `Skill error: ${e instanceof Error ? e.message : String(e)}`;
          });
          appendSystem(out);
          return;
        }
      }

      // ── Hook-defined custom slash commands ──────────────────────────────────
      // Matches readline handlers/index.ts lines 187-205
      if (cmd.startsWith('/')) {
        try {
          const hookResult = await hookRunner.current.handleSlashCmd(cmd).catch(() => ({ handled: false, output: '' }));
          if (hookResult.handled) {
            if (hookResult.output) {
              appendSystem(`Running hook command: ${cmd.split(/\s+/)[0]}`);
              let hookOut = '';
              await agent.runStream(hookResult.output, (c) => { hookOut += c; }).catch((e) => {
                hookOut = `Hook command error: ${e instanceof Error ? e.message : String(e)}`;
              });
              appendSystem(hookOut);
            }
            return;
          }
        } catch { /* non-fatal: fall through to unknown */ }
      }

      appendSystem(`Unknown command: ${cmd}\nType /help for available commands.`);
    }
  }, [agent, domain, sessionId, appendSystem, exit, onExit, inferProviderEnvKey, sessionLogger]);

  // ── Submit handler ───────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Debounce: prevent duplicate submits
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;

    // Add to input history
    setInputHistory((prev) => {
      if (prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed];
      if (next.length > 500) next.shift();
      return next;
    });

    // Log all user input (including slash cmds & !cmd) — readline parity:
    // repl.ts calls sessionLogger.logInput(input) BEFORE slash/!cmd branches
    sessionLogger.current.logInput(trimmed);

    try {
      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed);
        return;
      }

      // ── !cmd shell prefix ────────────────────────────────────────────────
      if (trimmed.startsWith('!')) {
        const shellCmd = trimmed.slice(1).trim();
        if (!shellCmd) return;
        // dim style: "  $ cmd" (matches readline chalk.dim)
        appendSystem(`  $ ${shellCmd}`);
        try {
          const { execSync } = await import('child_process');
          let shellOut = '';
          try {
            shellOut = execSync(shellCmd, {
              cwd: process.cwd(),
              timeout: 30000,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }) as unknown as string;
          } catch (shellErr) {
            const se = shellErr as { stdout?: string; stderr?: string };
            shellOut = se.stdout ?? '';
            // stderr shown with [stderr] prefix AND injected into context (readline parity)
            if (se.stderr) {
              const stderrTrim = se.stderr.trim();
              appendSystem(`[stderr] ${stderrTrim}`);
              // Inject with 'stderr: ' prefix (readline parity: repl.ts injects '\nstderr: ' + stderr)
              shellOut += (shellOut ? '\n' : '') + 'stderr: ' + stderrTrim;
            }
          }
          const trimOut = shellOut.trim();
          if (trimOut) appendSystem(trimOut);
          else appendSystem('(no output)');
          // Inject into agent context for follow-up questions
          agent.injectContext(`$ ${shellCmd}\n${shellOut}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          appendSystem(`[shell error] ${errMsg}`);
        }
        return;
      }

      // ── @file reference resolution ────────────────────────────────────────
      const resolveAtRefs = async (input: string): Promise<string> => {
        const { existsSync, readFileSync } = await import('fs');
        const { join, extname } = await import('path');
        return input.replace(/@([^\s,;]+)/g, (_match, ref: string) => {
          // Skip @run-agent-xxx — subagent mentions, not file refs
          if (ref.startsWith('run-agent-') || ref.startsWith('ask-')) return _match;
          const fullPath = join(process.cwd(), ref);
          if (!existsSync(fullPath)) return _match;
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const lang = extname(ref).slice(1) || '';
            return `\n<file path="${ref}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</file>\n`;
          } catch { return _match; }
        });
      };

      // ── LLM path ────────────────────────────────────────────────────────
      // Resolve @file references before sending
      const resolvedInput = await resolveAtRefs(trimmed);

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed, timestamp: new Date().toISOString() },
      ]);
      // (logInput already called above, before slash/!cmd branching)
      setToolCalls([]);
      setIsStreaming(true);
      toolSeqRef.current = 0;
      setStatusInfo((s) => ({ ...s, isThinking: 'low' }));

      abortRef.current = new AbortController();
      let firstChunk = true;

      try {
        // Run hook pre_prompt
        const hookCtx = await hookRunner.current.run({
          event: 'pre_prompt', prompt: resolvedInput, cwd: process.cwd(),
        }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

        let finalInput = resolvedInput;
        if (!hookCtx.proceed) {
          // Yellow warning style (matches readline chalk.yellow)
          appendSystem(`[hook] Blocked: ${hookCtx.value ?? 'no reason given'}`);
          return;
        }
        if (hookCtx.injection) {
          finalInput = `${resolvedInput}\n\n---\n${hookCtx.injection}`;
        }

        // ── Consume pending image (from Ctrl+V) ───────────────────────────
        type AgentWithImage = typeof agent & { _pendingImage?: { data: string; mimeType: string } };
        const agentWithImg = agent as AgentWithImage;
        if (agentWithImg._pendingImage) {
          const imgBlock = agentWithImg._pendingImage;
          delete agentWithImg._pendingImage;
          // injectImagePrompt expects ImageBlock with 'type' field
          try {
            agent.injectImagePrompt(finalInput, {
              type: 'image',
              data: imgBlock.data,
              mimeType: imgBlock.mimeType,
            });
            finalInput = ''; // already injected
            // Confirm image was consumed (readline parity: repl.ts prints "(Image attached to this request)" at submit time)
            appendSystem('(Image attached to this request)');
          } catch { /* provider may not support images */ }
        }

        if (finalInput) {
          await agent.runStream(
          finalInput,
          (chunk) => {
            if (firstChunk) {
              firstChunk = false;
              setStatusInfo((s) => ({ ...s, isThinking: 'medium' }));
            }
            appendAssistant(chunk);
            sessionLogger.current.logChunk(chunk);
          },
          {
            onToolStart: async (name, args) => {
              // Trigger on_tool_call hook (readline parity: hooks.ts on_tool_call event)
              // This allows hooks to observe or block individual tool calls
              const toolHookCtx = await hookRunner.current.run({
                event: 'on_tool_call',
                toolName: name,
                toolArgs: args as Record<string, unknown>,
                cwd: process.cwd(),
              }).catch(() => ({ proceed: true, value: undefined }));
              if (!toolHookCtx.proceed) {
                appendSystem(`[hook] Tool blocked: ${name} — ${toolHookCtx.value ?? '(no reason)'}`);
                // Note: cannot abort mid-stream from this callback; log the block
              }
              const seqKey = `${name}#${toolSeqRef.current++}`;
              toolStartRef.current.set(seqKey, Date.now());
              // summarizeArgs: priority keys first (matches spinner.ts summarizeArgs)
              const PRIO_KEYS = ['path', 'file', 'filepath', 'filename', 'dir', 'directory', 'command', 'cmd', 'script', 'query', 'url', 'text', 'content'];
              const argsObj = args as Record<string, unknown>;
              let bestVal = '';
              for (const k of PRIO_KEYS) {
                const v = argsObj[k];
                if (typeof v === 'string' && v.length > 0) { bestVal = v; break; }
              }
              if (!bestVal) {
                for (const v of Object.values(argsObj)) {
                  if (typeof v === 'string' && v.length > 0) { bestVal = v; break; }
                }
              }
              // Terminal-width-aware truncation (matches cols - name.length - 4)
              const cols = process.stdout.columns ?? 120;
              const maxArgLen = Math.max(0, cols - name.length - 4);
              const truncated = bestVal.length > maxArgLen;
              const argsStr = bestVal.length > 0
                ? bestVal.slice(0, maxArgLen) + (truncated ? '…' : '')
                : '';
              sessionLogger.current.logToolStart(name, args as Record<string, unknown>);
              setToolCalls((prev) => [
                ...prev,
                { id: seqKey, name, args: argsStr, status: 'running' },
              ]);
              setStatusInfo((s) => ({ ...s, isThinking: 'medium' }));
            },
            onToolEnd: (name, success, durationMs) => {
              const seqKey = [...toolStartRef.current.keys()].find((k) => k.startsWith(`${name}#`));
              if (seqKey) toolStartRef.current.delete(seqKey);
              sessionLogger.current.logToolEnd(name, success, durationMs ?? 0);
              setToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === seqKey
                    ? { ...tc, status: success ? 'done' : 'failed', durationMs }
                    : tc
                )
              );
              // Append tool result as permanent system message (readline parity, with trailing period)
              const dur = durationMs !== undefined
                ? durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
                : '';
              const resultLine = success
                ? `↳ ${name} done${dur ? ` (${dur})` : ''}.`
                : `[failed] ↳ ${name} failed${dur ? ` (${dur})` : ''}.`;
              appendSystem(resultLine);
            },
          },
          undefined,
          abortRef.current.signal,
        );
        } // end if (finalInput)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sessionLogger.current.logError(msg);
        // ── API 401/403: auto-trigger configureAgent ─────────────────────
        const isAbortError = msg.includes('aborted') || msg.includes('AbortError') || msg.includes('signal');
        if (isAbortError) {
          // Abort is handled by handleAbort (Esc key), don't show error
          return;
        }
        const isAuthError = /401|403|unauthorized|invalid.api.key|authentication|API_KEY|api.key|No API key/i.test(msg);
        if (isAuthError) {
          appendSystem(`[auth error] ${msg}`);
          appendSystem('Starting API key setup...');
          try {
            const { configureAgent } = await import('../configure.js');
            await configureAgent(
              'API authentication failed — please add or update your key',
              inferProviderEnvKey?.(msg),
            );
            // Reload .env and clear client cache (matches readline configureAgent flow)
            try {
              const { config: loadEnv } = await import('dotenv');
              const { resolve: r } = await import('path');
              loadEnv({ path: r(process.cwd(), '.env'), override: true });
              modelManager.clearClientCache();
            } catch { /* non-fatal */ }
            appendSystem('Keys updated. Try your request again.');
          } catch { /* configure not available */ }
        } else {
          // Non-auth error: show as system message (not assistant), keep chat history clean
          // Matches readline: console.error('✗ ' + msg) — displayed separately, not in history
          appendSystem(`[error] ${msg}`);
        }
        // ── post_response hook ─────────────────────────────────────────────
        // Collect full assistant output for post_response hook
        // (readline parity: hooks.ts post_response event after runStream completes)
      } finally {
        // Trigger post_response hook with accumulated assistant content
        try {
          const fullResponse = messages
            .filter((m) => m.role === 'assistant')
            .slice(-1)[0]?.content ?? '';
          await hookRunner.current.run({
            event: 'post_response',
            response: fullResponse,
            cwd: process.cwd(),
          }).catch(() => {});
        } catch { /* non-fatal */ }
        abortRef.current = null;
        setIsStreaming(false);
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
        // Flush buffered output to log
        sessionLogger.current.flushOutput();

        // Update token estimate + auto-compact check
        // Use estimateHistoryTokens for accurate tool-call-aware counting
        // (matches readline's estimateHistoryTokens in status bar; shouldCompact uses the same fn)
        try {
          const h = agent.getHistory();
          import('../../core/context/context-compressor.js').then(
            ({ estimateHistoryTokens, shouldCompact, autoCompact }) => {
              const est = estimateHistoryTokens(h);
              setStatusInfo((s) => ({ ...s, estimatedTokens: est }));

              // ── Auto compact: delegate threshold logic to shouldCompact() ─
              const decision = shouldCompact(h);
              if (decision.shouldCompact && h.length >= 4) {
                const pct = Math.round(est / contextLength * 100);
                appendSystem(`Context at ${pct}% — auto-compacting...`);
                autoCompact(h, (msg) => appendSystem(msg)).then((compacted) => {
                  if (compacted > 0) {
                    appendSystem(`Auto-compact complete: ${compacted} turns compressed.`);
                  }
                }).catch(() => { /* non-fatal */ });
              }
            }
          ).catch(() => {
            // Fallback: naive estimate if module unavailable
            const h2 = agent.getHistory();
            const est2 = h2.reduce((acc, m) => {
              const c = (m as { content?: string }).content;
              return acc + (typeof c === 'string' ? Math.ceil(c.length / 4) : 0);
            }, 0);
            setStatusInfo((s) => ({ ...s, estimatedTokens: est2 }));
          });
        } catch { /* non-fatal */ }
      }
    } finally {
      isSubmittingRef.current = false;
    }
  }, [agent, appendAssistant, appendSystem, handleSlashCommand]);

  // ── Abort ─────────────────────────────────────────────────────────────────
  const handleAbort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      appendAssistant('\n[aborted]');
      setIsStreaming(false);
      setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
    }
  }, [appendAssistant]);

  // Register abort function with parent so launch.ts SIGINT can abort before unmounting
  // (readline parity: repl.ts calls _currentAbort?.abort() in rl.on('close') cleanup)
  useEffect(() => {
    onRegisterAbort?.(() => {
      abortRef.current?.abort();
      abortRef.current = null;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterAbort]);

  // ── Global hotkeys (Ink useInput, active when not in PromptInput text) ───
  // Note: Ink's useInput receives ALL key events including those in PromptInput,
  // so we guard ctrl/special combos only.
  useInput((input, key) => {
    // ── Ctrl+T: cycle thinking level ────────────────────────────────────
    if (key.ctrl && input === 't') {
      thinkingIdxRef.current = (thinkingIdxRef.current + 1) % THINKING_CYCLE.length;
      const level = THINKING_CYCLE[thinkingIdxRef.current] as ThinkingLevel;
      try { agent.setThinkingLevel(level); } catch { /* not all providers support thinking */ }
      const label = level ?? 'none';
      appendSystem(`Thinking level: ${label}`);
      setStatusInfo((s) => ({ ...s, isThinking: (level ?? 'none') as 'none' | 'low' | 'medium' | 'high' }));
      return;
    }

    // ── Ctrl+L: single=clear messages, double=toggle verbose ────────────
    if (key.ctrl && input === 'l') {
      const now = Date.now();
      if (now - lastCtrlLRef.current < 500) {
        // Double press — toggle verbose/debug mode
        const nextVerbose = !verbose;
        setVerbose(nextVerbose);
        appendSystem(`Debug mode: ${nextVerbose ? 'ON' : 'OFF'}`);
        lastCtrlLRef.current = 0;
      } else {
        lastCtrlLRef.current = now;
        setMessages([]);
        setToolCalls([]);
      }
      return;
    }

    // ── Ctrl+G: open $EDITOR to compose input ───────────────────────────
    if (key.ctrl && input === 'g') {
      void (async () => {
        // EDITOR takes priority over VISUAL (readline parity: repl.ts uses EDITOR || VISUAL || 'vim')
        const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
        const { join } = await import('path');
        const { writeFileSync, readFileSync, unlinkSync, existsSync } = await import('fs');
        const { spawnSync } = await import('child_process');
        const tmpFile = join('/tmp', `uagent-input-${Date.now()}.txt`);
        // Read current prompt value to pre-populate editor (readline parity:
        // repl.ts writes rl.line into tmpFile so user edits their in-progress input)
        const currentPromptValue = currentPromptRef.current ?? '';
        try {
          writeFileSync(tmpFile, currentPromptValue, 'utf-8');
          // Suspend raw mode before spawning editor (readline parity:
          // repl.ts calls setRawMode(false) before editor, setRawMode(true) after)
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { /* non-fatal */ }
          }
          // Temporarily suspend Ink rendering by writing a note
          process.stdout.write(`\r\nOpening ${editor}...\r\n`);
          spawnSync(editor, [tmpFile], { stdio: 'inherit' });
          // Restore raw mode after editor exits
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch { /* non-fatal */ }
          }
          if (existsSync(tmpFile)) {
            const content = readFileSync(tmpFile, 'utf-8').trim();
            if (content) {
              // Backfill into input box instead of auto-submitting
              // (readline parity: repl.ts sets rl.line = content, calls rl.prompt()
              // so the user can review/edit the text before pressing Enter)
              setExternalPromptValue(content);
              // Reset to undefined after one tick so the effect can fire again next time
              setTimeout(() => setExternalPromptValue(undefined), 50);
            }
            try { unlinkSync(tmpFile); } catch { /* */ }
          }
        } catch (err) {
          appendSystem(`Editor error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }

    // ── Shift+Tab: cycle agent mode ──────────────────────────────────────
    if (key.shift && key.tab) {
      modeIdxRef.current = (modeIdxRef.current + 1) % AGENT_MODES.length;
      const nextMode = AGENT_MODES[modeIdxRef.current];
      setMode(nextMode);
      const prompt = MODE_PROMPTS[nextMode] ?? '';
      try { agent.setSystemPrompt(prompt); } catch { /* non-fatal */ }
      appendSystem(`Mode: ${nextMode}`);
      return;
    }

    // ── Esc×2: rollback last turn ─────────────────────────────────────────
    if (key.escape && !isStreaming) {
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
        const history = agent.getHistory();
        if (history.length >= 2) {
          const removed = history.slice(-2);
          agent.setHistory(history.slice(0, -2));
          setMessages((prev) => prev.slice(0, -2));
          const preview = String(
            (removed[0] as { content?: unknown })?.content ?? ''
          ).slice(0, 80).replace(/\n/g, ' ');
          appendSystem(`Rolled back: "${preview}"`);
        } else {
          appendSystem('(nothing to roll back)');
        }
        lastEscRef.current = 0;
      } else {
        lastEscRef.current = now;
      }
      return;
    }
    if (!key.escape) lastEscRef.current = 0;

    // ── Ctrl+V: paste image from clipboard ───────────────────────────────
    if (key.ctrl && input === 'v') {
      void (async () => {
        const { spawnSync, execSync } = await import('child_process');
        const { existsSync, readFileSync, unlinkSync } = await import('fs');
        const { join } = await import('path');
        const tmpPath = join('/tmp', `uagent-clip-${Date.now()}.png`);
        let handled = false;

        // ── macOS: pngpaste ──────────────────────────────────────────────
        try {
          execSync('which pngpaste 2>/dev/null', { stdio: 'pipe' });
          try {
            spawnSync('pngpaste', [tmpPath]);
            if (existsSync(tmpPath)) {
              const base64 = readFileSync(tmpPath).toString('base64');
              try { unlinkSync(tmpPath); } catch { /* */ }
              (agent as typeof agent & { _pendingImage?: { data: string; mimeType: string } })._pendingImage = { data: base64, mimeType: 'image/png' };
              appendSystem('Image from clipboard attached. Now type your question.');
              handled = true;
            } else {
              appendSystem('No image in clipboard. (Tip: copy an image first)');
              handled = true;
            }
          } catch { /* pngpaste ran but failed — no image */ }
        } catch { /* pngpaste not installed */ }

        // ── Linux: xclip (readline parity: repl.ts tries xclip as fallback) ─
        if (!handled) {
          try {
            execSync('which xclip 2>/dev/null', { stdio: 'pipe' });
            try {
              execSync(`xclip -selection clipboard -t image/png -o > "${tmpPath}"`, { shell: '/bin/sh' });
              if (existsSync(tmpPath)) {
                const base64 = readFileSync(tmpPath).toString('base64');
                try { unlinkSync(tmpPath); } catch { /* */ }
                (agent as typeof agent & { _pendingImage?: { data: string; mimeType: string } })._pendingImage = { data: base64, mimeType: 'image/png' };
                appendSystem('Image from clipboard attached. Now type your question.');
                handled = true;
              } else {
                appendSystem('No image in clipboard.');
                handled = true;
              }
            } catch { /* xclip failed — no image in clipboard */ }
          } catch { /* xclip not installed */ }
        }

        if (!handled) {
          appendSystem('No image in clipboard.\n  macOS: brew install pngpaste\n  Linux: sudo apt install xclip');
        }
      })();
      return;
    }

    // ── Ctrl+R: toggle reverse-search mode ──────────────────────────────
    if (key.ctrl && input === 'r') {
      if (!historySearch) {
        setHistorySearch(true);
        setHistoryQuery('');
        setHistorySearchMatch(null);
        historySearchIdxRef.current = -1;
      } else {
        const nextIdx = historySearchIdxRef.current + 1;
        const { match, idx } = findHistoryMatch(historyQuery, nextIdx, inputHistory);
        historySearchIdxRef.current = idx;
        setHistorySearchMatch(match);
      }
      return;
    }
  });

  // ── Sync verbose state to agent ──────────────────────────────────────────
  useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (agent as any).verbose = verbose;
    } catch { /* */ }
  }, [agent, verbose]);

  // ── Fire initialPrompt on mount ──────────────────────────────────────────
  const firedInitial = useRef(false);
  useEffect(() => {
    if (initialPrompt && !firedInitial.current) {
      firedInitial.current = true;
      handleSubmit(initialPrompt).catch(() => {});
    }
    // Show startup hint once (last session available)
    if (startupHint) {
      appendSystem(startupHint);
    }
    // Show session log path at startup (readline parity: "Session log: /path")
    try {
      const logPath = sessionLogger.current.path;
      if (logPath) appendSystem(`Session log: ${logPath}`);
    } catch { /* non-fatal */ }
    // Show hook-defined custom slash commands at startup
    // (readline parity: repl.ts line 437-440 lists hookRunner.listSlashCommands() on start)
    try {
      const customCmds = (hookRunner.current as typeof hookRunner.current & { listSlashCommands?: () => Array<{ command: string }> }).listSlashCommands?.() ?? [];
      if (customCmds.length > 0) {
        appendSystem(`Custom commands: ${customCmds.map((c) => c.command).join('  ')}`);
      }
    } catch { /* non-fatal */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentModel = modelManager.getCurrentModel('main');

  // ── @file and @agent tab completions (computed lazily on mount) ──────────
  const [fileCompletions, setFileCompletions] = useState<string[]>([]);
  const [agentCompletions, setAgentCompletions] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const { readdirSync, statSync } = await import('fs');
      const { join, relative } = await import('path');
      const cwd = process.cwd();
      const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__']);
      const results: string[] = [];
      function collect(dir: string, depth: number): void {
        if (depth > 3 || results.length > 500) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
          if (IGNORE.has(entry)) continue;
          const full = join(dir, entry);
          try {
            const st = statSync(full);
            if (st.isDirectory()) collect(full, depth + 1);
            else results.push(relative(cwd, full));
          } catch { /* */ }
        }
      }
      collect(cwd, 0);
      setFileCompletions(results);
    })();
    void (async () => {
      const { subagentSystem } = await import('../../core/subagent-system.js');
      setAgentCompletions(subagentSystem.listAgents().map((a) => `run-agent-${a.name}`));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {messages.length === 0 && (
          <Box paddingY={1} paddingLeft={2}>
            <Text color="gray" dimColor>
              Type <Text color="white">/help</Text> for commands ·{' '}
              <Text color="white">@file</Text> to attach files ·{' '}
              <Text color="white">Ctrl+C</Text> to exit
            </Text>
          </Box>
        )}
        <MessageList messages={messages} />
      </Box>

      {/* Active tool calls */}
      {toolCalls.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {toolCalls.filter((tc) => tc.status === 'running').map((tc) => (
            <ToolCallLine key={tc.id} call={tc} />
          ))}
        </Box>
      )}

      {/* Ctrl+R reverse-search overlay */}
      {historySearch && (
        <Box paddingLeft={2} paddingBottom={1}>
          <Text color="cyan" dimColor>(reverse-search) </Text>
          <Text color="cyan">{historyQuery}</Text>
          <Text>: </Text>
          {historySearchMatch
            ? <Text color="white">{historySearchMatch}</Text>
            : <Text color="gray" dimColor>{historyQuery ? 'no match' : '_'}</Text>
          }
          <Text color="gray" dimColor>  [Enter=accept  Esc/Ctrl+C=cancel  Ctrl+R=next]</Text>
        </Box>
      )}

      {/* Prompt input */}
      <Box paddingTop={1} paddingLeft={2} paddingBottom={1}>
        <PromptInput
          domain={domain}
          mode={mode}
          isStreaming={isStreaming}
          onSubmit={handleSubmit}
          onAbort={handleAbort}
          historyItems={inputHistory}
          slashCompletions={SLASH_COMPLETIONS}
          fileCompletions={fileCompletions}
          agentCompletions={agentCompletions}
          historySearch={historySearch}
          historySearchMatch={historySearchMatch}
          onHistorySearchInput={(ch, isBackspace) => {
            if (isBackspace) {
              setHistoryQuery((q) => {
                const nq = q.slice(0, -1);
                historySearchIdxRef.current = -1;
                const { match } = findHistoryMatch(nq, 0, inputHistory);
                setHistorySearchMatch(match);
                return nq;
              });
            } else {
              setHistoryQuery((q) => {
                const nq = q + ch;
                historySearchIdxRef.current = -1;
                const { match } = findHistoryMatch(nq, 0, inputHistory);
                setHistorySearchMatch(match);
                return nq;
              });
            }
          }}
          onHistorySearchAccept={(val) => {
            setHistorySearch(false);
            setHistoryQuery('');
            setHistorySearchMatch(null);
            historySearchIdxRef.current = -1;
            // Backfill into input box, do NOT auto-submit
            // (readline parity: repl.ts injects into rl.line and writes text to prompt,
            //  requiring the user to press Enter again to actually send)
            if (val) {
              setExternalPromptValue(val);
              setTimeout(() => setExternalPromptValue(undefined), 50);
            }
          }}
          onHistorySearchCancel={() => {
            setHistorySearch(false);
            setHistoryQuery('');
            setHistorySearchMatch(null);
            historySearchIdxRef.current = -1;
          }}
          onValueChange={(val) => { currentPromptRef.current = val; }}
          externalValue={externalPromptValue}
          onEOF={() => { void handleSlashCommand('/exit'); }}
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        model={currentModelDisplay || modelDisplayName || currentModel}
        domain={domain}
        sessionId={sessionId}
        {...statusInfo}
        mode={mode}
      />
    </Box>
  );
}
