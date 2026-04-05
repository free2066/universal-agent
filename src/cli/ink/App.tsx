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
}

export function App({
  agent,
  domain: initialDomain,
  sessionId,
  modelDisplayName,
  contextLength = 128000,
  onExit,
  initialPrompt,
  inferProviderEnvKey,
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

    // ── /resume [session-id] ─────────────────────────────────────────────────
    if (cmd.startsWith('/resume') || cmd === '/continue') {
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
          appendSystem(`Session "${sub}" not found.`);
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
          appendSystem('No saved session found.');
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
      appendSystem(`Branched session saved as: ${branchId}\nUse /resume ${branchId} to restore later.`);
      return;
    }

    // ── /rename <name> ───────────────────────────────────────────────────────
    if (cmd.startsWith('/rename ')) {
      const { saveSnapshot } = await import('../../core/memory/session-snapshot.js');
      const newName = cmd.slice('/rename '.length).trim();
      if (!newName) { appendSystem('Usage: /rename <session-name>'); return; }
      const history = agent.getHistory();
      saveSnapshot(`named-${newName}`, history);
      appendSystem(`Session saved as: named-${newName}`);
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
            const lastStr = z.lastUsed ? z.lastUsed.toLocaleDateString() : 'never';
            lines.push(`  ${z.name.padEnd(20)} last: ${lastStr}, calls: ${z.callCount}`);
          }
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
        appendSystem('No MCP servers configured.\n  Run: uagent mcp add -- npx -y <server-package>');
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
        }
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
      } else {
        lines.push('', `  Total: ${totalCount} skill(s) installed`);
      }
      appendSystem(lines.join('\n'));
      return;
    }

    // ── /metrics ─────────────────────────────────────────────────────────────
    if (cmd === '/metrics') {
      const { sessionMetrics } = await import('../../core/metrics.js');
      appendSystem(sessionMetrics.getSummary());
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
          specs.forEach((s, i) => lines.push(`  ${i + 1}.  ${s.date}  ${s.name}`));
          appendSystem(lines.join('\n'));
        }
      } else {
        appendSystem('Generating spec...');
        try {
          const { generateSpec } = await import('../../core/tools/code/spec-generator.js');
          const result = await generateSpec(desc, process.cwd());
          appendSystem(`Spec saved: ${result.path}\n\n${result.content}`);
        } catch (err) {
          appendSystem(`Spec failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    // ── /hooks ───────────────────────────────────────────────────────────────
    if (cmd === '/hooks') {
      const hooks = hookRunner.current.listHooks();
      if (!hooks.length) {
        appendSystem('No hooks configured. Create .uagent/hooks.json to add hooks.');
      } else {
        const lines = ['Lifecycle Hooks:', ''];
        for (const h of hooks) {
          const status = h.enabled !== false ? 'on ' : 'off';
          lines.push(`  [${status}] [${h.event.padEnd(15)}] ${(h.description ?? h.type ?? '').slice(0, 60)}`);
        }
        appendSystem(lines.join('\n'));
      }
      return;
    }

    // ── /purify ───────────────────────────────────────────────────────────────
    if (cmd.startsWith('/purify')) {
      const isDryRun = cmd.includes('--dry-run') || cmd.includes('-d');
      appendSystem('Running self-heal (purify)...');
      try {
        const { selfHealTool } = await import('../../core/tools/code/self-heal.js');
        const result = await selfHealTool.handler({
          path: process.cwd(), dry_run: isDryRun, severity: 'warning', commit: false, max_fixes: 20,
        });
        appendSystem(String(result));
      } catch (err) {
        appendSystem(`Purify error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── /cost ────────────────────────────────────────────────────────────────
    if (cmd === '/cost') {
      const { sessionMetrics } = await import('../../core/metrics.js');
      const stats = sessionMetrics.getStats();
      const lines = ['Cost Estimate:', ''];
      lines.push(`  LLM calls    : ${stats.calls}`);
      lines.push(`  Input tokens : ${stats.totalInputTokens.toLocaleString()}`);
      lines.push(`  Output tokens: ${stats.totalOutputTokens.toLocaleString()}`);
      lines.push(`  Duration     : ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
      lines.push(`  Failed calls : ${stats.failedCalls}`);
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
        '',
        '  Context:',
        '    /tokens          show token usage',
        '    /context         show context window stats',
        '    /compact         compress context to memory',
        '    /history [n]     show recent prompts (default 10)',
        '',
        '  Memory:',
        '    /memory          memory stats',
        '    /memory pin <t>  pin a memory',
        '    /memory list     list memories',
        '    /memory forget   clear memories',
        '    /memory ingest   extract insights from session',
        '',
        '  Tools:',
        '    /tasks           task board',
        '    /mcp             MCP servers',
        '    /team            active teammates',
        '    /inbox           lead inbox',
        '    /skills          custom slash commands',
        '    /plugins         domain plugins',
        '    /metrics         LLM call metrics',
        '    /cost            token cost estimate',
        '    /hooks           lifecycle hooks',
        '    /review          AI code review',
        '    /inspect [path]  code inspection',
        '    /purify          self-heal fixes',
        '    /spec [desc]     spec generation',
        '    /init            create .uagent/AGENTS.md',
        '    /rules           show loaded rules',
        '',
        '  Input:',
        '    @file            attach file to message',
        '    Esc              abort streaming',
        '    Up/Down          navigate history',
        '    Tab              autocomplete commands',
      ].join('\n'));
      return;
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

    try {
      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed);
        return;
      }

      // ── LLM path ────────────────────────────────────────────────────────
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed, timestamp: new Date().toISOString() },
      ]);
      // Log user input
      sessionLogger.current.logInput(trimmed);
      setToolCalls([]);
      setIsStreaming(true);
      toolSeqRef.current = 0;
      setStatusInfo((s) => ({ ...s, isThinking: 'low' }));

      abortRef.current = new AbortController();
      let firstChunk = true;

      try {
        // Run hook pre_prompt
        const hookCtx = await hookRunner.current.run({
          event: 'pre_prompt', prompt: trimmed, cwd: process.cwd(),
        }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

        let finalInput = trimmed;
        if (!hookCtx.proceed) {
          appendSystem(`[hook] Blocked: ${hookCtx.value ?? 'no reason given'}`);
          return;
        }
        if (hookCtx.injection) {
          finalInput = `${trimmed}\n\n---\n${hookCtx.injection}`;
        }

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
            onToolStart: (name, args) => {
              const seqKey = `${name}#${toolSeqRef.current++}`;
              toolStartRef.current.set(seqKey, Date.now());
              const argsStr = Object.entries(args as Record<string, unknown>)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
                .join(', ');
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
            },
          },
          undefined,
          abortRef.current.signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sessionLogger.current.logError(msg);
        appendAssistant(`\n[Error] ${msg}`);
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));
        // Flush buffered output to log
        sessionLogger.current.flushOutput();

        // Update token estimate
        try {
          const h = agent.getHistory();
          const est = h.reduce((acc, m) => {
            const c = (m as { content?: string }).content;
            return acc + (typeof c === 'string' ? Math.ceil(c.length / 4) : 0);
          }, 0);
          setStatusInfo((s) => ({ ...s, estimatedTokens: est }));
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

    // ── Ctrl+L: clear screen (Ink equivalent — clear messages) ──────────
    if (key.ctrl && input === 'l') {
      setMessages([]);
      setToolCalls([]);
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
            }
          } catch { /* pngpaste failed */ }
        } catch { /* pngpaste not installed */ }
        if (!handled) {
          appendSystem('No image in clipboard. (macOS: brew install pngpaste)');
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

  // ── Fire initialPrompt on mount ──────────────────────────────────────────
  const firedInitial = useRef(false);
  useEffect(() => {
    if (initialPrompt && !firedInitial.current) {
      firedInitial.current = true;
      handleSubmit(initialPrompt).catch(() => {});
    }
  }, [initialPrompt, handleSubmit]);

  const currentModel = modelManager.getCurrentModel('main');

  return (
    <Box flexDirection="column" height="100%">
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {messages.length === 0 && (
          <Box paddingY={1} paddingLeft={2}>
            <Text color="gray" dimColor>
              Type <Text color="white">/help</Text> for commands ·{' '}
              <Text color="white">@file</Text> to attach files ·{' '}
              Press <Text color="white">Esc</Text> to abort streaming
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
            if (val) handleSubmit(val).catch(() => {});
          }}
          onHistorySearchCancel={() => {
            setHistorySearch(false);
            setHistoryQuery('');
            setHistorySearchMatch(null);
            historySearchIdxRef.current = -1;
          }}
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        model={modelDisplayName || currentModel}
        domain={domain}
        sessionId={sessionId}
        {...statusInfo}
        mode={mode}
      />
    </Box>
  );
}
