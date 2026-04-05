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
import { Box, Text, useApp } from 'ink';
import { MessageList, type ChatMessage } from './MessageList.js';
import { PromptInput } from './PromptInput.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import { ToolCallLine, type ToolCallInfo } from './ToolCallLine.js';
import type { AgentCore } from '../../core/agent.js';
import { HookRunner } from '../../core/hooks.js';
import { modelManager } from '../../models/model-manager.js';

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
  const [mode] = useState('default');
  const [statusInfo, setStatusInfo] = useState<Omit<StatusBarProps, 'model' | 'domain' | 'sessionId'>>({
    isThinking: 'none',
    estimatedTokens: 0,
    contextLength,
  });

  const abortRef = useRef<AbortController | null>(null);
  const toolSeqRef = useRef(0);
  const toolStartRef = useRef<Map<string, number>>(new Map());
  const isSubmittingRef = useRef(false); // debounce guard

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

  // ── Slash command handler (Ink-safe) ────────────────────────────────────
  const handleSlashCommand = useCallback(async (input: string) => {
    const cmd = input.trim();

    // Built-in Ink-native commands first
    if (cmd === '/exit' || cmd === '/quit') {
      onExit?.();
      exit();
      return;
    }

    if (cmd === '/clear') {
      setMessages([]);
      setToolCalls([]);
      return;
    }

    if (cmd.startsWith('/domain')) {
      const parts = cmd.split(/\s+/);
      const newDomain = parts[1];
      if (newDomain) {
        setDomain(newDomain);
        appendSystem(`Domain set to: ${newDomain} (takes effect on next message)`);
      } else {
        appendSystem(`Current domain: ${domain}`);
      }
      return;
    }

    if (cmd === '/help') {
      appendSystem([
        'Available commands:',
        '  /clear           — clear screen',
        '  /exit  /quit     — exit',
        '  /domain <name>   — switch domain (data|dev|service|auto)',
        '  /model <name>    — switch model',
        '  /models          — list available models',
        '  /log             — show session log path',
        '  /logs            — list recent sessions',
        '  /history         — show conversation history',
        '  /compact         — compress context',
        '  /tokens          — show token usage',
        '  /cost            — show cost estimate',
        '  /metrics         — show LLM call metrics',
        '  /plugins         — show loaded plugins',
        '  /memory          — show memory items',
        '  /tasks           — show task board',
        '  /review          — code review',
        '  /spec            — spec generation menu',
        '  /agents          — show active agents',
        '  /hooks           — manage lifecycle hooks',
        '  /status          — show session status',
        '',
        '  @file            — attach file contents to message',
        '  Esc              — abort current streaming',
        '  ↑/↓              — navigate input history',
        '  Tab              — autocomplete /commands',
      ].join('\n'));
      return;
    }

    // For all other slash commands: delegate to the readline handlers
    // but intercept console.log/console.error to capture their output
    // safely within Ink's rendering model.
    const captured: string[] = [];
    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    const capture = (...args: unknown[]) => {
      // Strip ANSI color codes for Ink display
      const text = args.map((a) => String(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
      captured.push(text);
    };

    console.log = capture;
    console.error = capture;
    console.warn = capture;

    try {
      const slashMod = await import('../repl/slash-handlers.js') as {
        handleSlash: (input: string, ctx: unknown) => Promise<boolean>;
      };

      const fakeRl = {
        prompt: () => {},
        pause: () => {},
        resume: () => {},
        setPrompt: () => {},
        close: () => {},
        on: () => fakeRl,
        removeListener: () => fakeRl,
      };

      const fakeLogger = {
        logInput: () => {},
        logChunk: () => {},
        logToolStart: () => {},
        logToolEnd: () => {},
        logError: () => {},
        flushOutput: () => {},
        close: () => {},
        path: '',
      };

      const slashCtx = {
        agent,
        rl: fakeRl,
        hookRunner: hookRunner.current,
        sessionLogger: fakeLogger,
        options: { domain, verbose: false },
        SESSION_ID: sessionId,
        getModelDisplayName: (id: string) => id,
        makePrompt: () => '',
        loadLastSnapshot: () => null,
        saveSnapshot: () => {},
        formatAge: (ts: number) => {
          const diff = Date.now() - ts;
          if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
          if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
          return `${Math.round(diff / 3600000)}h ago`;
        },
        inferProviderEnvKey: inferProviderEnvKey ?? (() => undefined),
      };

      // Some handlers do process.stdout.write — capture that too
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') {
          const text = chunk.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
          if (text.trim()) captured.push(text);
        }
        return true;
      };

      try {
        await slashMod.handleSlash(cmd, slashCtx);
      } finally {
        process.stdout.write = origWrite;
      }
    } catch (err) {
      captured.push(`[Error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    }

    // Display captured output as a system message
    const output = captured.join('\n').trim();
    if (output) {
      appendSystem(output);
    }
  }, [agent, domain, sessionId, appendSystem, exit, onExit, inferProviderEnvKey]);

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
          },
          {
            onToolStart: (name, args) => {
              const seqKey = `${name}#${toolSeqRef.current++}`;
              toolStartRef.current.set(seqKey, Date.now());
              const argsStr = Object.entries(args as Record<string, unknown>)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
                .join(', ');
              setToolCalls((prev) => [
                ...prev,
                { id: seqKey, name, args: argsStr, status: 'running' },
              ]);
              setStatusInfo((s) => ({ ...s, isThinking: 'medium' }));
            },
            onToolEnd: (name, success, durationMs) => {
              const seqKey = [...toolStartRef.current.keys()].find((k) => k.startsWith(`${name}#`));
              if (seqKey) toolStartRef.current.delete(seqKey);
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
        appendAssistant(`\n[Error] ${msg}`);
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setStatusInfo((s) => ({ ...s, isThinking: 'none' }));

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
