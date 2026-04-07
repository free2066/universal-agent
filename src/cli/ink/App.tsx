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
  '/help', '/clear', '/exit', '/resume', '/rewind', '/compact', '/tokens', '/cost', '/usage',
  '/model', '/models', '/domain', '/continue',
  '/diff', '/review', '/inspect', '/purify',
  '/spec', '/spec:brainstorm', '/spec:write-plan', '/spec:execute-plan',
  '/agents', '/team', '/tasks', '/worktrees', '/inbox',
  '/image', '/history', '/hooks', '/insights', '/init', '/rules', '/memory',
  '/mcp', '/log', '/logs',
  '/context', '/status', '/copy', '/export',
  '/search',
  '/branch', '/rename', '/add-dir',
  '/terminal-setup', '/bug', '/doctor', '/output-style',
  '/skills', '/plugin', '/logout', '/permissions',
  '/metrics', '/plugins',
  '/thinkback',
  '/commit', '/security-review',  // Round 7: auto-commit + security audit
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
  /** Called on mount with a function that closes the real session logger.
   *  Allows launch.ts SIGINT handler to flush/close the logger on Ctrl+C.
   *  (readline parity: rl.on('close') always calls sessionLogger.close()) */
  onRegisterLoggerClose?: (closeFn: () => void) => void;
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
  onRegisterLoggerClose,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const hookRunner = useRef(new HookRunner(process.cwd()));

  // ── State ─────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Ref to messages for accessing latest value inside async callbacks
  const messagesRef = useRef<ChatMessage[]>([]);
  // Keep ref in sync with state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── Streaming throttle buffer ─────────────────────────────────────────────
  // Accumulate streaming chunks in a ref and flush to state at most once per
  // STREAM_FLUSH_MS. This prevents a full Ink re-render on every single chunk,
  // eliminating the "flicker" visible during long streaming responses.
  const STREAM_FLUSH_MS = 80;
  const streamBufRef = useRef('');
  const streamFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreamBuf = useCallback(() => {
    streamFlushTimer.current = null;
    const buf = streamBufRef.current;
    if (!buf) return;
    streamBufRef.current = '';
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: last.content + buf }];
      }
      return [...prev, { role: 'assistant' as const, content: buf, timestamp: new Date().toISOString() }];
    });
    setMsgScrollOffset(0);
  }, []);
  // Scroll offset for virtualized message list (0=latest, higher=older)
  const [msgScrollOffset, setMsgScrollOffset] = useState(0);
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
    sessionTokens: 0,
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

  // ── Info overlay state (for /logs, /log — long text shown at bottom, Esc/Enter to close) ──
  const [infoOverlay, setInfoOverlay] = useState<string | null>(null);

  // ── Generic picker state (shared by /domain, /output-style, /spec, /agents) ──
  interface GenericPickerItem { id: string; label: string; detail?: string; }
  interface GenericPickerState {
    title: string;
    items: GenericPickerItem[];
    onSelect: (item: GenericPickerItem) => void;
  }
  const [genericPicker, setGenericPicker] = useState<GenericPickerState | null>(null);
  const [genericPickerIdx, setGenericPickerIdx] = useState(0);

  // ── Model picker state (for /model with no arg) ───────────────────────
  interface ModelPickerItem { id: string; label: string; provider: string; ctx: string; }
  const [modelPicker, setModelPicker] = useState<ModelPickerItem[] | null>(null);
  const [modelPickerIdx, setModelPickerIdx] = useState(0);

  /** Build friendly display name for a model id, using WQ_MODELS name map */
  const getModelLabel = useCallback((id: string): string => {
    const wqMap: Record<string, string> = {};
    (process.env.WQ_MODELS || '').split(',').forEach(entry => {
      const parts = entry.trim().split(':');
      const epId = parts[0]?.trim() ?? '';
      const name = parts[1]?.trim() ?? '';
      if (epId && name) wqMap[epId] = name;
    });
    return wqMap[id] ?? id;
  }, []);

  // ── Ctrl+R reverse-search state ─────────────────────────────────────────
  const [historySearch, setHistorySearch] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const historySearchIdxRef = useRef(-1);
  const [historySearchMatch, setHistorySearchMatch] = useState<string | null>(null);

  // ── Ctrl+F global session search state (Batch 3) ─────────────────────────
  const [globalSearchVisible, setGlobalSearchVisible] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<Array<{
    sessionId: string; savedAt: number; role: string; snippet: string; messageIndex: number;
  }>>([]);
  const [globalSearchIdx, setGlobalSearchIdx] = useState(0);

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

    // Assistant streaming chunks: buffer and throttle-flush to avoid per-chunk re-renders
    if (role === 'assistant') {
      streamBufRef.current += text;
      if (!streamFlushTimer.current) {
        streamFlushTimer.current = setTimeout(flushStreamBuf, STREAM_FLUSH_MS);
      }
      return;
    }

    // Non-assistant (user, system, tool): flush any pending stream buf first, then append immediately
    if (streamBufRef.current) {
      if (streamFlushTimer.current) {
        clearTimeout(streamFlushTimer.current);
        streamFlushTimer.current = null;
      }
      flushStreamBuf();
    }

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === role) {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role, content: text, timestamp: new Date().toISOString() }];
    });
    setMsgScrollOffset(0);
  }, [flushStreamBuf]);

  const appendAssistant = useCallback((text: string) => appendMessage('assistant', text), [appendMessage]);
  const appendSystem = useCallback((text: string) => appendMessage('system', text), [appendMessage]);

  // Flush pending stream buf and stop streaming — call instead of bare stopStreaming()
  const stopStreaming = useCallback(() => {
    if (streamFlushTimer.current) {
      clearTimeout(streamFlushTimer.current);
      streamFlushTimer.current = null;
    }
    flushStreamBuf();
    stopStreaming();
  }, [flushStreamBuf]);

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
        const prevDomain = domain;
        agent.setDomain(sub);
        setDomain(sub);
        appendSystem(`Domain → ${sub}`);
        // Emit domain_switch hook (Batch 2)
        import('../../core/hooks.js').then(({ emitHook }) => {
          emitHook('domain_switch', { prevValue: prevDomain, newValue: sub });
        }).catch(() => { /* non-fatal */ });
      } else {
        // No arg: show interactive picker (Ink enhancement)
        const DOMAINS = ['auto', 'data', 'dev', 'service'];
        setGenericPicker({
          title: 'Select Domain',
          items: DOMAINS.map(d => ({ id: d, label: d, detail: d === domain ? '(current)' : '' })),
          onSelect: (item) => {
            const prevD = domain;
            agent.setDomain(item.id);
            setDomain(item.id);
            appendSystem(`Domain → ${item.id}`);
            import('../../core/hooks.js').then(({ emitHook }) => {
              emitHook('domain_switch', { prevValue: prevD, newValue: item.id });
            }).catch(() => { /* non-fatal */ });
          },
        });
        setGenericPickerIdx(Math.max(0, DOMAINS.indexOf(domain)));
      }
      return;
    }

    // ── /model [name] ────────────────────────────────────────────────────────
    if (cmd.startsWith('/model') && !cmd.startsWith('/models')) {
      if (sub) {
        const prevModel = modelManager.getCurrentModel('main');
        agent.setModel(sub);
        modelManager.setPointer('main', sub);
        // Update StatusBar model display and context length
        const newProfile = modelManager.listProfiles().find((p) => p.name === sub);
        const newCtxLen = newProfile?.contextLength ?? 128000;
        const label = getModelLabel(sub);
        setCurrentModelDisplay(label);
        setStatusInfo((s) => ({ ...s, contextLength: newCtxLen }));
        appendSystem(`Model switched to: ${label}`);
        // Emit model_switch hook (Batch 2)
        import('../../core/hooks.js').then(({ emitHook }) => {
          emitHook('model_switch', { prevValue: prevModel, newValue: sub });
        }).catch(() => { /* non-fatal */ });
      } else {
        // Open interactive picker (readline parity: showModelPicker with ↑↓ navigation)
        const profiles = modelManager.listProfiles();
        const items: ModelPickerItem[] = profiles.map((p) => {
          const ctx2 = p.contextLength >= 1000000
            ? `${(p.contextLength / 1000000).toFixed(1)}M`
            : `${Math.round(p.contextLength / 1000)}k`;
          return { id: p.name, label: getModelLabel(p.name), provider: p.provider, ctx: ctx2 };
        });
        const currentModel2 = modelManager.getCurrentModel('main');
        const currentIdx = items.findIndex((it) => it.id === currentModel2);
        setModelPicker(items);
        setModelPickerIdx(currentIdx >= 0 ? currentIdx : 0);
      }
      return;
    }

    // ── /models [switch <name>] ──────────────────────────────────────────────
    if (cmd.startsWith('/models')) {
      if (sub === 'switch' && parts[2]) {
        agent.setModel(parts[2]);
        modelManager.setPointer('main', parts[2]);
        // Update StatusBar (readline parity: agent-handlers.ts updateStatusBar)
        const newProfile2 = modelManager.listProfiles().find((p) => p.name === parts[2]);
        const displayName2 = getModelLabel(parts[2]);
        const newCtx2 = newProfile2?.contextLength ?? 128000;
        setStatusInfo((s) => ({ ...s, contextLength: newCtx2 }));
        setCurrentModelDisplay(displayName2);
        appendSystem(`Model → ${displayName2}`);
      } else {
        const profiles = modelManager.listProfiles();
        const pointers = modelManager.getPointers();
        const current3 = modelManager.getCurrentModel('main');
        const lines = ['Available models:', ''];
        lines.push(`  ${'NAME'.padEnd(24)} ${'PROVIDER'.padEnd(12)} ${'CONTEXT'.padEnd(8)} POINTER`);
        lines.push('  ' + '─'.repeat(58));
        for (const p of profiles) {
          const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
          const isActive = p.name === current3;
          const ctx2 = p.contextLength >= 1000000
            ? `${(p.contextLength / 1000000).toFixed(1)}M`
            : `${Math.round(p.contextLength / 1000)}k`;
          const label2 = getModelLabel(p.name);
          lines.push(`  ${(isActive ? '● ' : '○ ') + label2.padEnd(22)} ${p.provider.padEnd(12)} ${ctx2.padEnd(8)} ${role ? `[${role}]` : ''}`);
        }
        lines.push('');
        lines.push('  /model              — interactive picker (↑↓ to select)');
        lines.push('  /models switch <name>  — switch by name');
        lines.push('  uagent models add    — add custom model');
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      }
      return;
    }

    // ── /log ────────────────────────────────────────────────────────────────
    if (cmd === '/log') {
      const logPath = sessionLogger.current.path;
      setInfoOverlay([
        'Current session log:',
        `  ${logPath}`,
        `  To share with AI: cat "${logPath}" | pbcopy`,
        '',
        '  [any key to close]',
      ].join('\n'));
      return;
    }

    // ── /logs [list] ─────────────────────────────────────────────────────────
    // (readline parity: handlers/index.ts line 58 routes '/logs' OR '/logs list')
    if (cmd === '/logs' || cmd === '/logs list') {
      const { listLogs } = await import('../session-logger.js');
      const logs = listLogs();
      if (!logs.length) {
        setInfoOverlay('No session logs found.\n\n  [any key to close]');
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
        lines.push('');
        lines.push('  [any key to close]');
        setInfoOverlay(lines.join('\n'));
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
      setInfoOverlay([
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
        '',
        '  [any key to close]',
      ].join('\n'));
      return;
    }

    // ── /tokens /context ────────────────────────────────────────────────────
    if (cmd === '/context') {
      const { shouldCompact } = await import('../../core/context/context-compressor.js');
      const history = agent.getHistory();
      const decision = shouldCompact(history);
      const used = decision.estimatedTokens;
      const total = decision.contextLength;
      const pct = total > 0 ? Math.round((used / total) * 100) : 0;
      const pctCapped = Math.min(pct, 100);

      // ASCII progress bar — 40 chars wide
      const BAR_WIDTH = 40;
      const filled = Math.round((pctCapped / 100) * BAR_WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      const barColor = pctCapped >= 85 ? '!' : pctCapped >= 60 ? '~' : ' ';

      // Per-role token breakdown (rough: char / 4)
      const roleBuckets: Record<string, number> = { system: 0, user: 0, assistant: 0, tool: 0 };
      for (const m of history) {
        const role = m.role === 'tool' ? 'tool' : (m.role as string) in roleBuckets ? m.role as string : 'user';
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        roleBuckets[role] = (roleBuckets[role] ?? 0) + Math.ceil(text.length / 4);
      }
      const bucketTotal = Object.values(roleBuckets).reduce((a, b) => a + b, 0) || 1;
      const fmtN = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

      const mkRoleBar = (n: number, color: string) => {
        const w = Math.max(1, Math.round((n / bucketTotal) * 20));
        return color.repeat(w);
      };

      const lines = [
        'Context Window',
        '',
        `  [${bar}] ${barColor} ${pctCapped}%  (${fmtN(used)} / ${fmtN(total)})`,
        '',
        '  Breakdown by role:',
        `  ${'system'.padEnd(10)} ${'▓'.repeat(Math.max(1, Math.round((roleBuckets.system / bucketTotal) * 24))).padEnd(24)}  ${fmtN(roleBuckets.system).padStart(6)}  (${Math.round((roleBuckets.system / bucketTotal) * 100)}%)`,
        `  ${'user'.padEnd(10)} ${'▓'.repeat(Math.max(1, Math.round((roleBuckets.user / bucketTotal) * 24))).padEnd(24)}  ${fmtN(roleBuckets.user).padStart(6)}  (${Math.round((roleBuckets.user / bucketTotal) * 100)}%)`,
        `  ${'assistant'.padEnd(10)} ${'▓'.repeat(Math.max(1, Math.round((roleBuckets.assistant / bucketTotal) * 24))).padEnd(24)}  ${fmtN(roleBuckets.assistant).padStart(6)}  (${Math.round((roleBuckets.assistant / bucketTotal) * 100)}%)`,
        `  ${'tool'.padEnd(10)} ${'▓'.repeat(Math.max(1, Math.round((roleBuckets.tool / bucketTotal) * 24))).padEnd(24)}  ${fmtN(roleBuckets.tool).padStart(6)}  (${Math.round((roleBuckets.tool / bucketTotal) * 100)}%)`,
        '',
        `  Messages in ctx  : ${history.length}`,
        `  Compact needed   : ${decision.shouldCompact ? 'Yes — run /compact' : 'No'}`,
        '',
        '  Tip: /compact — compress context;  /clear — start fresh',
        '',
        '  [any key to close]',
      ];
      setInfoOverlay(lines.join('\n'));
      return;
    }
    if (cmd === '/tokens') {
      const { shouldCompact } = await import('../../core/context/context-compressor.js');
      const history = agent.getHistory();
      const decision = shouldCompact(history);
      const pct = ((decision.estimatedTokens / decision.contextLength) * 100).toFixed(1);
      setInfoOverlay([
        'Context Usage:',
        `  Estimated tokens : ${decision.estimatedTokens.toLocaleString()}`,
        `  Context limit    : ${decision.contextLength.toLocaleString()}`,
        `  Usage            : ${pct}%  (threshold: ${(decision.threshold / decision.contextLength * 100).toFixed(0)}%)`,
        `  Turns in history : ${history.length}`,
        `  Compact needed   : ${decision.shouldCompact ? 'Yes' : 'No'}`,
        '',
        '  Run /compact to manually compress now.',
        '',
        '  [any key to close]',
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
      // Guard: nothing to continue if history is empty
      // (readline parity: session-handlers.ts handleContinue checks h.length < 2)
      const hc = agent.getHistory();
      if (hc.length < 2) { appendSystem('Nothing to continue (no active session).'); return; }
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

    // ── /usage [days] — enhanced fee & token breakdown (Batch 2) ────────────
    // /usage        → today's breakdown by model (tokens + cost)
    // /usage 7      → last 7 days summary
    // /cost [days]  → alias for /usage
    if (cmd.startsWith('/usage') || cmd.startsWith('/cost')) {
      try {
        const { usageTracker } = await import('../../models/usage-tracker.js');
        const { sessionMetrics } = await import('../../core/metrics.js');
        const daysArg = parts[1] ? parseInt(parts[1], 10) : 1;
        const days = isNaN(daysArg) || daysArg < 1 ? 1 : Math.min(daysArg, 30);

        const lines: string[] = [`Usage Report (last ${days} day${days > 1 ? 's' : ''}):`, ''];

        // Per-model breakdown from UsageTracker
        const todayUsage = usageTracker.loadTodayUsage();
        const modelEntries = Object.entries(todayUsage.byModel);
        if (modelEntries.length > 0) {
          lines.push('  Today — by model:');
          lines.push(`  ${'MODEL'.padEnd(28)} ${'CALLS'.padEnd(6)} ${'INPUT'.padEnd(10)} ${'OUTPUT'.padEnd(10)} COST`);
          lines.push('  ' + '-'.repeat(72));
          let totIn = 0, totOut = 0, totCost = 0;
          for (const [model, mu] of modelEntries.sort((a, b) => b[1].costUSD - a[1].costUSD)) {
            totIn += mu.input; totOut += mu.output; totCost += mu.costUSD;
            const inStr = mu.input >= 1000 ? `${(mu.input / 1000).toFixed(1)}k` : String(mu.input);
            const outStr = mu.output >= 1000 ? `${(mu.output / 1000).toFixed(1)}k` : String(mu.output);
            const costStr = mu.costUSD >= 0.01 ? `$${mu.costUSD.toFixed(4)}` : `<$0.01`;
            lines.push(`  ${model.slice(0, 27).padEnd(28)} ${String(mu.calls).padEnd(6)} ${inStr.padEnd(10)} ${outStr.padEnd(10)} ${costStr}`);
          }
          lines.push('  ' + '-'.repeat(72));
          const totInStr = totIn >= 1000 ? `${(totIn / 1000).toFixed(1)}k` : String(totIn);
          const totOutStr = totOut >= 1000 ? `${(totOut / 1000).toFixed(1)}k` : String(totOut);
          lines.push(`  ${'TOTAL'.padEnd(28)} ${''.padEnd(6)} ${totInStr.padEnd(10)} ${totOutStr.padEnd(10)} $${totCost.toFixed(4)}`);
        } else {
          lines.push('  Today: No API calls recorded yet.');
        }

        // Session metrics (in-memory)
        lines.push('');
        lines.push('  This session:');
        const sessionSummary = sessionMetrics.getSummary();
        for (const l of sessionSummary.split('\n')) lines.push('  ' + l);

        // Multi-day summary (if days > 1)
        if (days > 1) {
          lines.push('');
          lines.push(usageTracker.getSummary(days));
        }

        lines.push('');
        lines.push('  Set limits: UAGENT_DAILY_TOKEN_LIMIT=100000 UAGENT_DAILY_COST_LIMIT=2.0');
        lines.push('  [any key to close]');
        setInfoOverlay(lines.join('\n'));
      } catch (e) {
        appendSystem(`Usage stats error: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // ── /rewind — interactive snapshot picker ────────────────────────────────
    if (cmd === '/rewind') {
      const { listAllSnapshots, loadSnapshot } = await import('../../core/memory/session-snapshot.js');
      const { getContentText } = await import('../../models/types.js');
      const snaps = listAllSnapshots(12);
      if (!snaps.length) {
        appendSystem('No saved snapshots found. Use /branch to save a snapshot.');
        return;
      }
      const fmtAge = (ts: number) => {
        const d = Date.now() - ts;
        if (d < 60000) return `${Math.round(d / 1000)}s ago`;
        if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
        if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
        return `${Math.round(d / 86400000)}d ago`;
      };
      setGenericPicker({
        title: 'Rewind to snapshot  (↑↓ navigate · Enter restore · Esc cancel)',
        items: snaps.map((s) => ({
          id: s.sessionId,
          // displayTitle: customTitle (user) wins over aiTitle (AI), fallback to sessionId
          label: s.displayTitle ?? s.sessionId.slice(0, 28),
          detail: `${fmtAge(s.savedAt)}  ${s.messageCount} msgs`,
        })),
        onSelect: (item) => {
          const snap = loadSnapshot(item.id);
          if (snap && snap.messages.length >= 2) {
            agent.setHistory(snap.messages as never);
            const restored = snap.messages
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: getContentText(m.content),
                timestamp: new Date().toISOString(),
              }));
            setMessages(restored);
            appendSystem(`Rewound to "${item.id}" (${snap.messages.length} messages)`);
            // Emit session_restore hook (Batch 2)
            import('../../core/hooks.js').then(({ emitHook }) => {
              emitHook('session_restore', { newValue: item.id });
            }).catch(() => { /* non-fatal */ });
          } else {
            appendSystem(`Failed to load snapshot "${item.id}".`);
          }
        },
      });
      setGenericPickerIdx(0);
      return;
    }

    // ── /resume [session-id] ─────────────────────────────────────────────────
    if (cmd.startsWith('/resume')) {
      const { loadSnapshot, listAllSnapshots } = await import('../../core/memory/session-snapshot.js');
      const { getContentText } = await import('../../models/types.js');
      const fmtAge = (ts: number) => {
        const d = Date.now() - ts;
        if (d < 60000) return `${Math.round(d / 1000)}s ago`;
        if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
        if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
        return `${Math.round(d / 86400000)}d ago`;
      };
      const doRestore = (snapId: string) => {
        const snap = loadSnapshot(snapId);
        if (snap && snap.messages.length >= 2) {
          agent.setHistory(snap.messages as never);
          const restored: ChatMessage[] = snap.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: getContentText(m.content),
              timestamp: new Date().toISOString(),
            }));
          setMessages(restored);
          appendSystem(`Restored session "${snapId}" (${snap.messages.length} messages)`);
        } else {
          appendSystem(`Session "${snapId}" not found or empty.`);
        }
      };
      if (sub) {
        doRestore(sub);
      } else {
        // No arg: show interactive picker
        const snaps = listAllSnapshots(12);
        if (!snaps.length) {
          appendSystem('No saved sessions found. Use /branch to save one.');
          return;
        }
        setGenericPicker({
          title: 'Resume session  (↑↓ navigate · Enter select · Esc cancel)',
          items: snaps.map((s) => ({
            id: s.sessionId,
            // displayTitle: customTitle (user) wins over aiTitle (AI), fallback to sessionId
            label: s.displayTitle ?? s.sessionId.slice(0, 28),
            detail: `${fmtAge(s.savedAt)}  ${s.messageCount} msgs`,
          })),
          onSelect: (item) => doRestore(item.id),
        });
        setGenericPickerIdx(0);
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
    // (readline parity: handlers/index.ts uses startsWith('/rename') NO trailing space)
    if (cmd.startsWith('/rename')) {
      const { saveSnapshot } = await import('../../core/memory/session-snapshot.js');
      const newName = cmd.slice('/rename'.length).trim();
      if (!newName) { appendSystem('Usage: /rename <session-name>'); return; }
      const history = agent.getHistory();
      saveSnapshot(`named-${newName}`, history);
      // (readline parity: session-handlers.ts handleRename prints 2 lines)
      appendSystem(`Session renamed to: ${newName}\n  Restore with: /resume (then pick from list)`);
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
        setInfoOverlay([
          'Memory Stats:',
          `  Pinned  : ${stats.pinned}`,
          `  Insight : ${stats.insight}`,
          `  Fact    : ${stats.fact}`,
          '',
          '  /memory pin <text>  — pin a memory',
          '  /memory list        — list all memories',
          '  /memory forget      — clear all memories',
          '  /memory ingest      — extract insights from this session',
          '',
          '  [any key to close]',
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
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
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
      } else {
        // (readline parity: memory-handlers.ts line 65 shows unknown subcommand hint)
        appendSystem(`Unknown /memory subcommand. Try: /memory  /memory pin <text>  /memory list  /memory forget  /memory ingest`);
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
      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /search [query] (Batch 3: global session history search) ─────────────
    if (cmd.startsWith('/search')) {
      const query = cmd.replace('/search', '').trim();
      if (!query) {
        // No query: open interactive Ctrl+F search panel
        setGlobalSearchVisible(true);
        setGlobalSearchQuery('');
        setGlobalSearchResults([]);
        setGlobalSearchIdx(0);
        appendSystem('Ctrl+F search opened. Type to search all session history. Enter=resume Esc=close');
        return;
      }
      const { searchSnapshots, formatAge } = await import('../../core/memory/session-snapshot.js');
      const results = searchSnapshots(query, 10);
      if (!results.length) {
        appendSystem(`No sessions found matching "${query}"`);
        return;
      }
      const lines = [`Search results for "${query}" (${results.length} found):`, ''];
      for (const r of results) {
        lines.push(`  [${r.role}]  ${r.snippet.slice(0, 100)}${r.snippet.length > 100 ? '…' : ''}`);
        lines.push(`          Session: ${r.sessionId}  (${formatAge(r.savedAt)})`);
        lines.push('');
      }
      lines.push('  Tip: /resume <sessionId> to restore a session  |  Ctrl+F for interactive search');
      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /tasks ───────────────────────────────────────────────────────────────
    if (cmd === '/tasks') {
      const { getTaskBoard } = await import('../../core/task-board.js');
      const result = getTaskBoard(process.cwd()).listAll(true); // includeWorktrees=true (Batch 2)
      appendSystem(result || 'No tasks.');
      return;
    }

    // ── /worktrees ───────────────────────────────────────────────────────────
    if (cmd === '/worktrees') {
      try {
        const { worktreeSyncTool } = await import('../../core/tools/agents/worktree-tools.js');
        const result = await worktreeSyncTool.handler({});
        appendSystem(result as string);
      } catch (e) {
        appendSystem(`Worktree sync error: ${e instanceof Error ? e.message : String(e)}`);
      }
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
          setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
        }
      } else {
        const agents = subagentSystem.listAgents();
        if (!agents.length) {
          // (readline parity: agent-handlers.ts handleAgents shows Tip even when empty)
          appendSystem('No subagents defined.\n\n  Tip: /agents clean [days] — show stale subagents');
          return;
        }
        // Show interactive picker: select an agent to run
        setGenericPicker({
          title: 'Select Agent to run',
          items: agents.map(a => ({ id: a.name, label: `@run-agent-${a.name}`, detail: a.description })),
          onSelect: (item) => {
            // Equivalent to user submitting @run-agent-<name>
            void handleSubmit(`@run-agent-${item.id}`);
          },
        });
        setGenericPickerIdx(0);
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

    // ── /diff [ref] ──────────────────────────────────────────────────────────
    // /diff                → staged diff (git diff --cached)
    // /diff HEAD           → all changes vs HEAD
    // /diff <branch/sha>   → diff vs that ref
    if (cmd.startsWith('/diff')) {
      const ref = sub ?? '';
      try {
        const { execSync } = await import('child_process');
        let gitArgs: string;
        let label: string;
        if (!ref) {
          // Prefer staged; fall back to working-tree
          const staged = execSync('git diff --cached --name-only', {
            cwd: process.cwd(), encoding: 'utf-8', timeout: 5000,
          }).trim();
          gitArgs = staged ? 'git diff --cached --stat' : 'git diff --stat';
          label = staged ? 'Staged changes' : 'Unstaged changes';
        } else if (ref === 'HEAD') {
          gitArgs = 'git diff HEAD --stat';
          label = 'Changes vs HEAD';
        } else {
          gitArgs = `git diff ${ref} --stat`;
          label = `Changes vs ${ref}`;
        }
        const stat = execSync(gitArgs, {
          cwd: process.cwd(), encoding: 'utf-8', timeout: 10000,
        }).trim();
        // Also get short log since ref
        let extraLog = '';
        if (ref) {
          try {
            extraLog = '\n\nCommits:\n' + execSync(`git log ${ref}..HEAD --oneline`, {
              cwd: process.cwd(), encoding: 'utf-8', timeout: 5000,
            }).trim();
          } catch { /* no commits = silent */ }
        }
        const output = stat || '(no changes)';
        appendSystem(`${label}:\n\n${output}${extraLog}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not a git repository')) {
          appendSystem('Not inside a git repository.');
        } else {
          appendSystem(`git diff error: ${msg.slice(0, 200)}`);
        }
      }
      return;
    }

    // ── /inbox ───────────────────────────────────────────────────────────────
    if (cmd === '/inbox') {
      const { getTeammateManager } = await import('../../core/teammate-manager.js');
      const msgs = getTeammateManager(process.cwd()).bus.readInbox('lead');
      appendSystem(msgs.length > 0 ? JSON.stringify(msgs, null, 2) : '(inbox empty)');
      return;
    }

    // ── /mcp auth <server> ───────────────────────────────────────────────────
    if (cmd.startsWith('/mcp auth')) {
      const srvName = cmd.replace('/mcp auth', '').trim();
      if (!srvName) {
        appendSystem('Usage: /mcp auth <server-name>');
        return;
      }
      appendSystem(`Starting OAuth flow for MCP server "${srvName}"...`);
      try {
        const { MCPManager } = await import('../../core/mcp-manager.js');
        const { getMcpAuth } = await import('../../core/mcp-auth.js');
        const mgr = new MCPManager(process.cwd());
        const serverList = mgr.listServers();
        const srv = serverList.find((s) => s.name === srvName);
        if (!srv) {
          appendSystem(`MCP server "${srvName}" not found in config.`);
          return;
        }
        if (!(srv as { oauth?: unknown }).oauth) {
          appendSystem(`Server "${srvName}" has no oauth config. Add oauth.authorizationUrl/tokenUrl/clientId to .mcp.json.`);
          return;
        }
        const auth = getMcpAuth(srvName);
        const token = await auth.authorize((srv as { oauth: Parameters<typeof auth.authorize>[0] }).oauth);
        appendSystem(`OAuth success for "${srvName}". Token valid for ${Math.floor((token.expiresAt - Date.now()) / 60000)} minutes.`);
      } catch (e) {
        appendSystem(`OAuth error: ${e instanceof Error ? e.message : String(e)}`);
      }
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
          // Show OAuth auth status for servers that have oauth config (Batch 3)
          let oauthStr = '';
          if ((s as { oauth?: unknown }).oauth) {
            try {
              const { getMcpAuth } = await import('../../core/mcp-auth.js');
              oauthStr = `  [oauth: ${getMcpAuth(s.name).status()}]`;
            } catch { oauthStr = '  [oauth: unavailable]'; }
          }
          lines.push(`  [${status}] ${s.name.padEnd(20)} [${s.type ?? 'stdio'}]  ${detail}${oauthStr}`);
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
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      }
      return;
    }

    // ── /init ────────────────────────────────────────────────────────────────
    if (cmd === '/init') {
      const { initAgentsMd } = await import('../../core/context/context-loader.js');
      setInfoOverlay(initAgentsMd(process.cwd()) + '\n\n  [any key to close]');
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
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
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
      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /metrics ─────────────────────────────────────────────────────────────
    if (cmd === '/metrics') {
      const { sessionMetrics } = await import('../../core/metrics.js');
      setInfoOverlay('LLM Call Metrics (this session):\n\n' + sessionMetrics.getSummary() + '\n\n  [any key to close]');
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
      // (readline parity: tool-handlers.ts handleDomainPlugins lines 466-477)
      const external = plugins.filter((p: { source: string }) => p.source !== 'builtin');
      if (external.length === 0) {
        lines.push('', '  No external plugins loaded.');
      }
      lines.push(
        '',
        '  To add a plugin with slash commands:',
        '    export default {',
        '      name: "my-plugin", description: "...", keywords: [], systemPrompt: "", tools: [],',
        '      slashCommands: [{ command: "/standup", description: "...", handler: async (args, ctx) => { ctx.onChunk("..."); } }],',
        '      hooks: [{ event: "pre_prompt", description: "...", handler: async (payload) => { return undefined; } }],',
        '    };',
        '    // Save to .uagent/plugins/<name>.js and restart uagent',
      );
      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /bug ─────────────────────────────────────────────────────────────────
    if (cmd.startsWith('/bug')) {
      const desc = cmd.slice('/bug'.length).trim();
      const logPath = sessionLogger.current.path;
      setInfoOverlay([
        'Bug Report',
        `  Session log  : ${logPath}`,
        `  Working dir  : ${process.cwd()}`,
        `  Model        : ${modelManager.getCurrentModel('main')}`,
        `  Session      : ${sessionId}`,
        ...(desc ? [`  Description  : ${desc}`] : []),
        '',
        '  Steps to report:',
        `  1. cat "${logPath}" | pbcopy`,
        '  2. Open issue tracker or KOncall',
        '  3. Paste log and describe the problem',
        '',
        '  Tip: /export — save full conversation to a file',
      ].join('\n'));
      return;
    }

    // ── /doctor — environment diagnostics ────────────────────────────────────
    if (cmd === '/doctor') {
      const lines: string[] = ['Doctor — Environment Diagnostics', ''];
      // Node / runtime
      lines.push(`  Runtime      : Node ${process.version}  (${process.platform}/${process.arch})`);
      lines.push(`  Working dir  : ${process.cwd()}`);
      lines.push(`  Session      : ${sessionId}`);
      lines.push(`  Session log  : ${sessionLogger.current.path}`);
      lines.push('');
      // Model info
      try {
        const m = modelManager.getCurrentModel('main');
        lines.push(`  Model (main) : ${m}`);
        const mTask = modelManager.getCurrentModel('task');
        const mCompact = modelManager.getCurrentModel('compact');
        if (mTask !== m) lines.push(`  Model (task) : ${mTask}`);
        if (mCompact !== m) lines.push(`  Model (cmpct): ${mCompact}`);
      } catch { lines.push('  Model        : (unavailable)'); }
      lines.push('');
      // API keys
      const keyChecks: Array<[string, string]> = [
        ['OPENAI_API_KEY', 'OpenAI'],
        ['ANTHROPIC_API_KEY', 'Anthropic'],
        ['GOOGLE_API_KEY', 'Google'],
        ['DEEPSEEK_API_KEY', 'DeepSeek'],
        ['MOONSHOT_API_KEY', 'Moonshot'],
      ];
      lines.push('  API keys:');
      for (const [env, name] of keyChecks) {
        const val = process.env[env];
        const status = val ? `set (${val.slice(0, 6)}...)` : 'not set';
        lines.push(`    ${name.padEnd(12)}: ${status}`);
      }
      lines.push('');
      // MCP servers
      try {
        const { MCPManager } = await import('../../core/mcp-manager.js');
        const mcpMgr = new MCPManager(process.cwd());
        const servers = mcpMgr.listServers();
        if (servers.length) {
          lines.push(`  MCP servers  : ${servers.length} configured`);
          for (const s of servers.slice(0, 5)) {
            lines.push(`    ${String(s.name ?? '').padEnd(20)} ${s.enabled ? 'enabled' : 'disabled'} (${s.type})`);
          }
        } else {
          lines.push('  MCP servers  : none configured');
        }
      } catch { lines.push('  MCP servers  : (unavailable)'); }
      lines.push('');
      // Memory
      try {
        const { getMemoryStore } = await import('../../core/memory/memory-store.js');
        const store = getMemoryStore();
        const stats = store.stats();
        lines.push(`  Memory       : ${stats.total} items (pinned:${stats.pinned} insight:${stats.insight} fact:${stats.fact})`);
      } catch { lines.push('  Memory       : (unavailable)'); }
      // Snapshots
      try {
        const { listAllSnapshots } = await import('../../core/memory/session-snapshot.js');
        const snaps = listAllSnapshots(3);
        lines.push(`  Snapshots    : ${snaps.length > 0 ? snaps.length + ' recent (latest: ' + snaps[0]?.sessionId.slice(0, 16) + ')' : 'none'}`);
      } catch { /* */ }
      lines.push('');
      lines.push('  [any key to close]');
      setInfoOverlay(lines.join('\n'));
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
    // IMPORTANT: NO trailing space -- bare '/spec:brainstorm' (no args) must also match here
    // (readline parity: memory-handlers.ts / handlers/index.ts use startsWith('/spec:brainstorm'))
    if (cmd.startsWith('/spec:brainstorm')) {
      const topic = cmd.slice('/spec:brainstorm'.length).trim();
      if (!topic) { appendSystem('Usage: /spec:brainstorm <topic or feature description>'); return; }
      appendSystem('Brainstorming...');
      setIsStreaming(true);
      try {
        const _bsPrompt = [
          `# Brainstorm: ${topic}`,
          '',
          'Please brainstorm design approaches and ideas for the following topic. Be creative and explore multiple angles:',
          '',
          `**Topic:** ${topic}`,
          '',
          'Provide:',
          '1. 3-5 distinct design approaches',
          '2. Pros and cons of each',
          '3. Key technical challenges to consider',
          '4. A recommended starting point',
        ].join('\n');
        // Stream chunks as assistant messages (readline parity: memory-handlers.ts streams to stdout)
        await agent.runStream(_bsPrompt, (c) => { appendAssistant(c); }).catch((err: unknown) => {
          appendSystem(`Brainstorm failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      } finally {
        stopStreaming();
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
          // Show interactive picker: select a spec to view
          setGenericPicker({
            title: 'Select Spec',
            items: specs.map((s, i) => ({
              id: String(i),
              label: (s as { name?: string }).name ?? `spec-${i + 1}`,
              detail: (s as { date?: string }).date ?? '',
            })),
            onSelect: async (item) => {
              const s = specs[+item.id] as { name?: string; date?: string; path?: string; content?: string };
              appendSystem([
                `Spec: ${s.name ?? item.label}  (${s.date ?? ''})`,
                s.path ? `Path: ${s.path}` : '',
                '',
                s.content ?? '(no content)',
              ].filter(l => l !== '').join('\n'));
            },
          });
          setGenericPickerIdx(0);
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
          setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
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
        // Reload after init so new config takes effect immediately
        // (readline parity: tool-handlers.ts /hooks init calls hookRunner.reload())
        hookRunner.current.reload();
        return;
      }
      // /hooks reload — reload hooks config from disk
      if (hookSub === 'reload') {
        hookRunner.current.reload();
        const count = hookRunner.current.listHooks().length;
        appendSystem(`Hooks reloaded. ${count} hook(s) active.`);
        return;
      }
      // /hooks — list hooks (reload first to ensure fresh config)
      // (readline parity: tool-handlers.ts handleHooksCmd calls hookRunner.reload() before listHooks)
      hookRunner.current.reload();
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
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
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
      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /doctor — environment diagnostic check (Round 5: claude-code /doctor parity) ──
    if (cmd === '/doctor') {
      const lines: string[] = ['🩺  Doctor — environment diagnostics', ''];
      // API keys
      const apiKeyChecks: { env: string; label: string }[] = [
        { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
        { env: 'OPENAI_API_KEY',    label: 'OpenAI' },
        { env: 'GEMINI_API_KEY',    label: 'Gemini' },
        { env: 'DEEPSEEK_API_KEY',  label: 'DeepSeek' },
        { env: 'GROQ_API_KEY',      label: 'Groq' },
        { env: 'WQ_API_KEY',        label: '万擎 (WQ)' },
      ];
      lines.push('API Keys:');
      for (const { env, label } of apiKeyChecks) {
        const val = process.env[env];
        if (val && val.length > 4) {
          const redacted = val.slice(0, 4) + '…' + val.slice(-2);
          lines.push(`  ✓  ${label.padEnd(14)} ${redacted}`);
        } else {
          lines.push(`  ·  ${label.padEnd(14)} not set`);
        }
      }
      // Model
      lines.push('');
      lines.push('Current Model:');
      const { modelManager: inkModelMgr } = await import('../../models/model-manager.js');
      const inkCurrentModel = inkModelMgr.getCurrentModel('main');
      lines.push(`  ✓  main: ${inkCurrentModel}`);
      const inkProfile = inkModelMgr.listProfiles().find(p => p.name === inkCurrentModel);
      if (inkProfile) {
        const ctxLbl = inkProfile.contextLength >= 1_000_000
          ? `${(inkProfile.contextLength / 1_000_000).toFixed(1)}M context`
          : `${Math.round(inkProfile.contextLength / 1000)}k context`;
        lines.push(`  ·  ${ctxLbl}`);
      }
      // MCP
      lines.push('');
      lines.push('MCP Servers:');
      try {
        const { MCPManager: _InkMCPMgr } = await import('../../core/mcp-manager.js');
        const inkMcp = new _InkMCPMgr(process.cwd());
        const inkServers = inkMcp.listServers().filter((s: { enabled: boolean }) => s.enabled);
        if (inkServers.length === 0) {
          lines.push('  ·  No servers configured');
        } else {
          for (const s of inkServers as Array<{ name: string; type: string }>) lines.push(`  ✓  ${s.name} (${s.type})`);
        }
      } catch { lines.push('  ✗  MCP manager unavailable'); }
      // Config
      lines.push('');
      lines.push('Config:');
      try {
        const { loadConfig: inkLoadCfg } = await import('../../cli/config-store.js');
        const inkCfg = inkLoadCfg();
        lines.push(`  ✓  config OK (${Object.keys(inkCfg).length} keys)`);
      } catch (e) { lines.push(`  ✗  config error: ${e instanceof Error ? e.message : String(e)}`); }

      setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
      return;
    }

    // ── /commit — auto-generate commit message (Round 7: claude-code parity) ──
    if (cmd.startsWith('/commit')) {
      // In Ink mode, delegate to the readline handler via runStream
      setIsStreaming(true);
      try {
        const { execSync: _inkExec } = await import('child_process');
        // Get diff
        let diff = '';
        try {
          diff = _inkExec('git diff --staged', { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 }) as string;
          if (!diff.trim()) diff = _inkExec('git diff HEAD', { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 }) as string;
        } catch (e) {
          appendSystem(`/commit: git error — ${e instanceof Error ? e.message : String(e)}`);
          stopStreaming();
          return;
        }
        if (!diff.trim()) {
          appendSystem('/commit: No changes to commit (git diff is empty).');
          stopStreaming();
          return;
        }
        // Generate commit message
        const MAX_DIFF = 12_000;
        const diffToSend = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n... [diff truncated]' : diff;
        const commitPrompt = [
          'Generate a concise git commit message following Conventional Commits format.',
          'Format: <type>(<scope>): <description>',
          'Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build',
          'Output ONLY the commit message, nothing else.',
          '',
          `Diff:\n${diffToSend}`,
        ].join('\n');
        const parts: string[] = [];
        await agent.runStream(commitPrompt, (c) => parts.push(c));
        const commitMsg = parts.join('').trim();
        if (commitMsg) {
          // Show message — user can copy and run git commit manually
          appendSystem(`Generated commit message:\n\n  ${commitMsg}\n\nRun: git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        } else {
          appendSystem('/commit: Could not generate commit message.');
        }
      } catch (e) {
        appendSystem(`/commit error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stopStreaming();
      }
      return;
    }

    // ── /security-review — security audit (Round 7: claude-code parity) ──
    if (cmd.startsWith('/security-review')) {
      const scope = cmd.replace('/security-review', '').trim() || 'src/ (or entire project)';
      setIsStreaming(true);
      const secPrompt = `You are a security researcher. Perform a thorough security audit of the codebase.
Scope: ${scope}

Check for: SQL Injection, XSS, RCE, Path Traversal, SSRF, hardcoded secrets, unsafe deserialization, IDOR, XXE.

Only report vulnerabilities with confidence ≥ 0.7.

For each finding:
### [SEVERITY] Title
**File:** path:line | **Category:** ... | **Confidence:** X.X
**Exploit:** How an attacker would exploit this
**Fix:** Specific code fix

Begin with a scope summary then list findings. If none found, say so.`;
      try {
        await agent.runStream(secPrompt, (c) => process.stdout.write(c));
      } catch (e) {
        appendSystem(`/security-review error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stopStreaming();
      }
      return;
    }

    // ── /permissions — manage allow/deny rules (Round 5: claude-code parity) ──
    if (cmd.startsWith('/permissions')) {
      try {
        const { getPermissionManager } = await import('../../core/agent/permission-manager.js');
        const permMgr = getPermissionManager(process.cwd());
        const subParts = cmd.split(/\s+/);
        const subCmd = subParts[1];
        const outputLines: string[] = [];
        if (subCmd === 'add-allow' || subCmd === 'add-deny') {
          const pattern = subParts.slice(2).join(' ');
          if (!pattern) { appendSystem(`Usage: /permissions ${subCmd} <ToolName(*)>`); return; }
          permMgr.addRule(subCmd === 'add-allow' ? 'allow' : 'deny', pattern);
          appendSystem(`Permission rule added: ${subCmd.replace('add-', '')} ${pattern}`);
        } else if (subCmd === 'remove') {
          const type = subParts[2] as 'allow' | 'deny';
          const pattern = subParts.slice(3).join(' ');
          if (!type || !pattern) { appendSystem('Usage: /permissions remove <allow|deny> <pattern>'); return; }
          permMgr.removeRule(type, pattern);
          appendSystem(`Permission rule removed: ${type} ${pattern}`);
        } else {
          // Show rules
          const formatted = permMgr.formatRules();
          outputLines.push('Permission Rules:', '', ...formatted.split('\n'));
          outputLines.push('');
          outputLines.push('  /permissions add-allow <ToolName>      — always allow this tool');
          outputLines.push('  /permissions add-deny <ToolName>       — always deny this tool');
          outputLines.push('  /permissions remove allow <ToolName>   — remove allow rule');
          outputLines.push('  /permissions remove deny <ToolName>    — remove deny rule');
          outputLines.push('  Current approvalMode: default | autoEdit | yolo (set via --approval-mode)');
          setInfoOverlay(outputLines.join('\n') + '\n\n  [any key to close]');
        }
      } catch (e) {
        appendSystem(`/permissions error: ${e instanceof Error ? e.message : String(e)}`);
      }
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
        // Operation hints (readline parity: tool-handlers.ts handlePlugin prints these)
        lines.push('');
        lines.push('  /plugin list         — show all extensions');
        lines.push('  /skills              — show only custom commands');
        setInfoOverlay(lines.join('\n') + '\n\n  [any key to close]');
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
        setInfoOverlay(condensed + truncated + '\n\n  [any key to close]');
      } catch (err) {
        appendSystem(`Insights failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /output-style [style] (Batch 3 enhanced: injects into system prompt) ──
    if (cmd.startsWith('/output-style')) {
      const style = cmd.replace('/output-style', '').trim();
      const OUTPUT_STYLES = [
        { id: 'plain',    label: 'plain',    detail: 'plain text, no markdown' },
        { id: 'markdown', label: 'markdown', detail: 'full markdown (default)' },
        { id: 'compact',  label: 'compact',  detail: 'concise output, minimal headers' },
      ];
      if (!style) {
        // No arg: show interactive picker
        const current = (agent as unknown as { getOutputStyle?: () => string }).getOutputStyle?.() ?? 'markdown';
        setGenericPicker({
          title: `Select Output Style  (current: ${current})`,
          items: OUTPUT_STYLES,
          onSelect: (item) => {
            // Batch 3: persist style into system prompt via setOutputStyle
            (agent as unknown as { setOutputStyle?: (s: string) => void }).setOutputStyle?.(item.id);
            appendSystem(`Output style → ${item.id} (injected into system prompt)`);
          },
        });
        setGenericPickerIdx(0);
        return;
      }
      const validStyles = OUTPUT_STYLES.map(s => s.id);
      if (!validStyles.includes(style)) {
        appendSystem(`Unknown style "${style}". Choose: ${validStyles.join(', ')}`);
        return;
      }
      // Batch 3: inject as persistent system prompt directive, not just context message
      (agent as unknown as { setOutputStyle?: (s: string) => void }).setOutputStyle?.(style);
      appendSystem(`Output style → ${style} (injected into system prompt)`);
      return;
    }

    // ── /terminal-setup ───────────────────────────────────────────────────────
    if (cmd === '/terminal-setup') {
      setInfoOverlay([
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
        '',
        '  [any key to close]',
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
        stopStreaming();
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
        stopStreaming();
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
      }
      return;
    }

    // ── /cost — now handled by /usage above (Batch 2 merged) ────────────────
    // kept as stub for safety; actual logic is in /usage block above

    // ── /thinkback (Batch 3: self-criticism / reflection mode) ───────────────
    if (cmd.startsWith('/thinkback')) {
      const history = agent.getHistory();
      // Find last assistant response
      const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
      if (!lastAssistant) {
        appendSystem('No previous AI response to reflect on.');
        return;
      }
      const prevContent = typeof lastAssistant.content === 'string'
        ? lastAssistant.content.slice(0, 2000)
        : '[previous response]';
      // Optional focus hint from command argument
      const focusHint = cmd.replace('/thinkback', '').trim();
      const focusStr = focusHint
        ? `Pay special attention to: ${focusHint}`
        : 'Consider accuracy, completeness, correctness, and missed edge cases.';
      const thinkbackPrompt = [
        '**Self-Reflection Request**',
        '',
        'Please critically review your previous response:',
        '',
        '```',
        prevContent,
        '```',
        '',
        `${focusStr}`,
        '',
        'In your reflection:',
        '1. Identify any errors, incorrect assumptions, or misleading statements',
        '2. Note gaps or missing information that would have been helpful',
        '3. Point out anything that could be clearer or better structured',
        '4. Provide a corrected/improved version if significant issues were found',
        '5. If the response was correct and complete, briefly confirm why',
        '',
        'Be concise and specific.',
      ].join('\n');
      void handleSubmit(thinkbackPrompt);
      return;
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (cmd === '/help') {
      setInfoOverlay([
        'Available commands:',
        '',
        '  Session:',
        '    /log             show session log path',
        '    /logs            list recent sessions',
        '    /status          show session info',
        '    /resume [id]     interactive session picker (or restore by id)',
        '    /rewind          interactive snapshot picker — restore any saved snapshot',
        '    /branch          save a branch of current session',
        '    /rename <name>   save session with a name',
        '    /export [dir]    export conversation to markdown',
        '    /copy            copy last AI reply to clipboard',
        '    /bug [desc]      show bug report info',
        '    /doctor          environment diagnostics (model, API keys, MCP, memory)',
        '    /clear           clear history and screen',
        '    /exit  /quit     exit',
        '',
        '  Model / Domain:',
        '    /model [name]    show or switch model',
        '    /models          list all models',
        '    /domain [name]   show or switch domain',
        '    /agents          list subagents',
        '    /logout          show API key status',
        '    /permissions     view/manage allow-deny rules (Round 5)',
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
        '    /tasks           task board (with worktree bindings)',
        '    /worktrees       worktree ↔ task sync table (Batch 2)',
        '    /diff [ref]      git diff stats — staged, HEAD, or vs <ref> (Batch 2)',
        '    /mcp             MCP servers (+ OAuth status for oauth-configured servers)',
        '    /mcp auth <srv>  trigger OAuth flow for a server (Batch 3)',
        '    /search [query]  search all session history (Batch 3) — Ctrl+F for interactive',
        '    /team            active teammates',
        '    /inbox           lead inbox',
        '    /skills          custom slash commands',
        '    /plugins         domain plugins',
        '    /plugin          local extensions (commands/agents/hooks)',
        '    /metrics         LLM call metrics',
        '    /usage [days]    token & cost breakdown by model (Batch 2)',
        '    /cost [days]     alias for /usage',
        '    /hooks           lifecycle hooks (20+ events)',
        '    /review          AI code review',
        '    /inspect [path]  code inspection',
        '    /purify          self-heal fixes',
        '    /spec [desc]     spec generation',
        '    /spec:brainstorm <topic>  brainstorm ideas',
        '    /spec:write-plan [topic]  generate implementation plan',
        '    /spec:execute-plan        execute last plan',
        '    /thinkback [focus]        self-criticism — AI reflects on its last response (Batch 3)',
        '    /init            create .uagent/AGENTS.md',
        '    /rules           show loaded rules',
        '',
        '  Plan Mode (Shift+Tab → plan):',
        '    Write tools blocked: Write/Edit/Bash are intercepted (Batch 2)',
        '    LLM instructed to plan-only, not execute',
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
          // Replace $ARGUMENTS and positional $1/$2/... params
          // (readline parity: handlers/index.ts replaces $1, $2, $3... via argParts.forEach)
          const argParts = skillArgs.split(/\s+/).filter(Boolean);
          let prompt = content.replace(/\$ARGUMENTS/g, skillArgs);
          argParts.forEach((arg, idx) => {
            prompt = prompt.replace(new RegExp(`\\$${idx + 1}`, 'g'), arg);
          });
          appendSystem(`Running skill: /${cmdName}`);
          // Stream skill output as assistant message for real-time rendering
          // (readline parity: handlers/index.ts streams each chunk to process.stdout)
          setIsStreaming(true);
          try {
            await agent.runStream(prompt, (c) => { appendAssistant(c); }).catch((e) => {
              appendSystem(`Skill error: ${e instanceof Error ? e.message : String(e)}`);
            });
          } finally {
            stopStreaming();
          }
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

      // Flush any leftover streaming buffer from previous turn before starting new one
      if (streamFlushTimer.current) {
        clearTimeout(streamFlushTimer.current);
        streamFlushTimer.current = null;
      }
      if (streamBufRef.current) {
        flushStreamBuf();
      }

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
            onToolEnd: (name, success, durationMs, errorMsg) => {
              const seqKey = [...toolStartRef.current.keys()].find((k) => k.startsWith(`${name}#`));
              if (seqKey) toolStartRef.current.delete(seqKey);
              sessionLogger.current.logToolEnd(name, success, durationMs ?? 0, errorMsg);
              setToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === seqKey
                    ? { ...tc, status: success ? 'done' : 'failed', durationMs }
                    : tc
                )
              );
              const dur = durationMs !== undefined
                ? durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
                : '';
              const resultLine = success
                ? `↳ ${name} done${dur ? ` (${dur})` : ''}.`
                : `[failed] ↳ ${name} failed${dur ? ` (${dur})` : ''}${errorMsg ? `: ${errorMsg.slice(0, 120)}` : ''}.`;
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
        stopStreaming();
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
              // sessionTokens: raw session size from UI messages (pre-compact representation)
              // Use messages ref to get the actual displayed messages token count
              const rawEst = messagesRef.current.reduce((acc, m) => {
                return acc + Math.ceil((m.content?.length ?? 0) / 4);
              }, 0);
              setStatusInfo((s) => ({ ...s, estimatedTokens: est, sessionTokens: rawEst > 0 ? rawEst : est }));

              // ── Auto compact: delegate threshold logic to shouldCompact() ─
              const decision = shouldCompact(h);
              if (decision.shouldCompact && h.length >= 4) {
                const pct = Math.round(est / contextLength * 100);
                appendSystem(`Context at ${pct}% — auto-compacting...`);
                autoCompact(h, (msg) => appendSystem(msg)).then((result) => {
                  if (result.wasCompacted) {
                    appendSystem(`Auto-compact complete: ${result.compactedTurns} turns compressed.`);
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
      stopStreaming();
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

  // Register real session logger close function with launch.ts SIGINT handler
  // so SIGINT closes the REAL logger (not the shadow copy in launch.ts).
  // (readline parity: rl.on('close') calls sessionLogger.close() on the live instance)
  useEffect(() => {
    onRegisterLoggerClose?.(() => {
      try { sessionLogger.current.close(); } catch { /* non-fatal */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterLoggerClose]);

  // ── Global hotkeys (Ink useInput, active when not in PromptInput text) ───
  // Note: Ink's useInput receives ALL key events including those in PromptInput,
  // so we guard ctrl/special combos only.
  useInput((input, key) => {
    // ── Info overlay (logs etc): any key closes it ────────────────────────────
    if (infoOverlay !== null) {
      setInfoOverlay(null);
      return;
    }

    // ── Message list scroll: PageUp / PageDown ─────────────────────────────
    if (key.pageUp) {
      setMsgScrollOffset((n) => n + 1);
      return;
    }
    if (key.pageDown) {
      setMsgScrollOffset((n) => Math.max(0, n - 1));
      return;
    }

    // ── Generic picker (domain / output-style / spec / agents): ↑↓ Enter Esc ─
    if (genericPicker) {
      if (key.upArrow) {
        setGenericPickerIdx((i) => (i - 1 + genericPicker.items.length) % genericPicker.items.length);
        return;
      }
      if (key.downArrow) {
        setGenericPickerIdx((i) => (i + 1) % genericPicker.items.length);
        return;
      }
      if (key.return) {
        const chosen = genericPicker.items[genericPickerIdx];
        if (chosen) genericPicker.onSelect(chosen);
        setGenericPicker(null);
        return;
      }
      if (key.escape) {
        setGenericPicker(null);
        appendSystem('Cancelled.');
        return;
      }
      return; // swallow all other keys while picker is open
    }

    // ── Model picker: ↑↓ navigate, Enter select, Esc cancel ──────────────
    if (modelPicker) {
      if (key.upArrow) {
        setModelPickerIdx((i) => (i - 1 + modelPicker.length) % modelPicker.length);
        return;
      }
      if (key.downArrow) {
        setModelPickerIdx((i) => (i + 1) % modelPicker.length);
        return;
      }
      if (key.return) {
        const chosen = modelPicker[modelPickerIdx];
        if (chosen) {
          agent.setModel(chosen.id);
          modelManager.setPointer('main', chosen.id);
          const prof = modelManager.listProfiles().find((p) => p.name === chosen.id);
          const ctxLen = prof?.contextLength ?? 128000;
          setCurrentModelDisplay(chosen.label);
          setStatusInfo((s) => ({ ...s, contextLength: ctxLen }));
          appendSystem(`Model switched to: ${chosen.label}`);
        }
        setModelPicker(null);
        return;
      }
      if (key.escape) {
        setModelPicker(null);
        appendSystem('Model selection cancelled.');
        return;
      }
      return; // swallow all other keys while picker is open
    }

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
      // Plan Mode: set env var so agent-loop.ts can block write tools (Batch 2)
      process.env.UAGENT_PLAN_MODE = nextMode === 'plan' ? '1' : '0';
      const prompt = MODE_PROMPTS[nextMode] ?? '';
      try { agent.setSystemPrompt(prompt); } catch { /* non-fatal */ }
      appendSystem(`Mode: ${nextMode}${nextMode === 'plan' ? ' (write tools blocked)' : ''}`);
      // Emit thinking_change / plan mode hooks
      import('../../core/hooks.js').then(({ emitHook }) => {
        emitHook('thinking_change', { newValue: nextMode });
      }).catch(() => { /* non-fatal */ });
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

    // ── Ctrl+F: global session search (Batch 3) ──────────────────────────
    if (key.ctrl && input === 'f') {
      if (globalSearchVisible) {
        setGlobalSearchVisible(false);
        setGlobalSearchQuery('');
        setGlobalSearchResults([]);
      } else {
        setGlobalSearchVisible(true);
        setGlobalSearchQuery('');
        setGlobalSearchResults([]);
        setGlobalSearchIdx(0);
      }
      return;
    }

    // ── Navigate global search results (when visible) ────────────────────
    if (globalSearchVisible) {
      if (key.escape) {
        setGlobalSearchVisible(false);
        setGlobalSearchQuery('');
        setGlobalSearchResults([]);
        return;
      }
      if (key.upArrow) {
        setGlobalSearchIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setGlobalSearchIdx((i) => Math.min(globalSearchResults.length - 1, i + 1));
        return;
      }
      if (key.return && globalSearchResults.length > 0) {
        const sel = globalSearchResults[globalSearchIdx];
        if (sel) {
          // Resume the selected session
          void handleSlashCommand(`/resume ${sel.sessionId}`);
          setGlobalSearchVisible(false);
          setGlobalSearchQuery('');
          setGlobalSearchResults([]);
        }
        return;
      }
      // Typing: update query and search
      if (!key.ctrl && !key.meta && input) {
        if (input === '\x7f' || input === '\b') {
          // Backspace
          const newQ = globalSearchQuery.slice(0, -1);
          setGlobalSearchQuery(newQ);
          if (newQ.trim().length >= 2) {
            import('../../core/memory/session-snapshot.js').then(({ searchSnapshots }) => {
              setGlobalSearchResults(searchSnapshots(newQ, 15));
              setGlobalSearchIdx(0);
            }).catch(() => {});
          } else {
            setGlobalSearchResults([]);
          }
        } else {
          const newQ = globalSearchQuery + input;
          setGlobalSearchQuery(newQ);
          if (newQ.trim().length >= 2) {
            import('../../core/memory/session-snapshot.js').then(({ searchSnapshots }) => {
              setGlobalSearchResults(searchSnapshots(newQ, 15));
              setGlobalSearchIdx(0);
            }).catch(() => {});
          } else {
            setGlobalSearchResults([]);
          }
        }
        return;
      }
      return; // absorb other keys when search is open
    }

  }); // end useInput

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
        <MessageList messages={messages} scrollOffset={msgScrollOffset} />
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

      {/* Ctrl+F global session history search overlay (Batch 3) */}
      {globalSearchVisible && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1} borderStyle="single" borderColor="blue">
          <Box flexDirection="row" gap={1}>
            <Text color="blue" bold>🔍 Session Search</Text>
            <Text color="gray" dimColor>  Ctrl+F=close  ↑↓=navigate  Enter=resume  Esc=close</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color="gray" dimColor>Query: </Text>
            <Text color="white">{globalSearchQuery || '_'}</Text>
            {globalSearchQuery.trim().length < 2 && (
              <Text color="gray" dimColor>  (type 2+ chars)</Text>
            )}
          </Box>
          {globalSearchResults.length > 0 && (
            <Box flexDirection="column">
              {globalSearchResults.slice(0, 8).map((r, idx) => {
                const isSel = idx === globalSearchIdx;
                return (
                  <Box key={`${r.sessionId}-${r.messageIndex}`} flexDirection="row" gap={1}>
                    <Text color={isSel ? 'blue' : 'gray'}>{isSel ? '▶' : ' '}</Text>
                    <Text color={isSel ? 'white' : 'gray'} bold={isSel}>[{r.role}]</Text>
                    <Text color={isSel ? 'white' : 'gray'} dimColor={!isSel}>{r.snippet.slice(0, 70)}</Text>
                    <Text color="gray" dimColor>  ({r.sessionId.slice(-8)})</Text>
                  </Box>
                );
              })}
            </Box>
          )}
          {globalSearchQuery.trim().length >= 2 && globalSearchResults.length === 0 && (
            <Text color="gray" dimColor>  No matches found</Text>
          )}
        </Box>
      )}

      {/* Prompt input */}
      <Box paddingLeft={2}>
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

      {/* /model interactive picker — shown below prompt, above status bar */}
      {modelPicker && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="single" borderColor="cyan">
          <Text color="cyan" bold>Select Model</Text>
          <Text color="gray" dimColor>  ↑↓ navigate · Enter select · Esc cancel</Text>
          {modelPicker.map((item, idx) => {
            const isSel = idx === modelPickerIdx;
            return (
              <Box key={item.id} flexDirection="row" gap={1}>
                <Text color={isSel ? 'cyan' : 'gray'}>{isSel ? '▶' : ' '}</Text>
                <Text color={isSel ? 'white' : 'gray'} bold={isSel}>{item.label.padEnd(22)}</Text>
                <Text color="gray" dimColor>{item.provider.padEnd(12)}</Text>
                <Text color={isSel ? 'green' : 'gray'} dimColor>{item.ctx}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Generic picker (domain / output-style / spec / agents) — below prompt, above status bar */}
      {genericPicker && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="single" borderColor="cyan">
          <Text color="cyan" bold>{genericPicker.title}</Text>
          <Text color="gray" dimColor>  ↑↓ navigate · Enter select · Esc cancel</Text>
          {genericPicker.items.map((item, idx) => {
            const isSel = idx === genericPickerIdx;
            return (
              <Box key={item.id} flexDirection="row" gap={1}>
                <Text color={isSel ? 'cyan' : 'gray'}>{isSel ? '▶' : ' '}</Text>
                <Text color={isSel ? 'white' : 'gray'} bold={isSel}>{item.label.padEnd(26)}</Text>
                {item.detail ? <Text color="gray" dimColor>{item.detail}</Text> : null}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Info overlay (for /logs, /log — long text shown at bottom, any key to close) */}
      {infoOverlay !== null && (
        <Box flexDirection="column" paddingLeft={2} paddingRight={1} borderStyle="single" borderColor="gray">
          <Text color="gray" dimColor>{infoOverlay}</Text>
        </Box>
      )}

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
