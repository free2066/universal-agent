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

import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { MessageList, type ChatMessage } from './MessageList.js';
import { PromptInput } from './PromptInput.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import { ToolCallLine, type ToolCallInfo } from './ToolCallLine.js';
import type { AgentCore } from '../../core/agent.js';
import { handleSlash, type SlashContext } from '../repl/slash-handlers.js';
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
  // Optional: initial prompt to fire on mount
  initialPrompt?: string;
  // Extra: slug key inferrer for API errors
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
  const [mode, setMode] = useState('default');
  const [statusInfo, setStatusInfo] = useState<Omit<StatusBarProps, 'model' | 'domain' | 'sessionId'>>({
    isThinking: 'none',
    estimatedTokens: 0,
    contextLength,
  });
  const [infoLine, setInfoLine] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Tool call sequence counter (per-stream)
  const toolSeqRef = useRef(0);
  const toolStartRef = useRef<Map<string, number>>(new Map());

  // ── Helper: append an assistant text message ────────────────────────────
  const appendAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        // Append to current assistant message
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role: 'assistant', content: text, timestamp: new Date().toISOString() }];
    });
  }, []);

  // ── Submit handler ───────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string) => {
    if (!input.trim()) return;

    // Add to input history
    setInputHistory((prev) => {
      if (prev[prev.length - 1] === input) return prev;
      const next = [...prev, input];
      if (next.length > 500) next.shift();
      return next;
    });

    // Handle slash commands
    if (input.startsWith('/')) {
      // Create a minimal SlashContext that bridges Ink to the existing handlers
      const fakeRl = {
        prompt: () => {},
        pause: () => {},
        resume: () => {},
        setPrompt: () => {},
        close: () => {},
      } as unknown as import('readline').Interface;

      const sessionLogger = {
        logInput: () => {},
        logChunk: () => {},
        logToolStart: () => {},
        logToolEnd: () => {},
        logError: () => {},
        flushOutput: () => {},
        close: () => {},
        path: '',
      };

      const slashCtx: SlashContext = {
        agent,
        rl: fakeRl,
        hookRunner: hookRunner.current,
        sessionLogger: sessionLogger as unknown as import('../session-logger.js').SessionLogger,
        options: { domain, verbose: false },
        SESSION_ID: sessionId,
        getModelDisplayName: (id: string) => id,
        makePrompt: () => '',
        loadLastSnapshot: () => null,
        saveSnapshot: () => {},
        formatAge: () => '',
        inferProviderEnvKey: inferProviderEnvKey ?? (() => undefined),
      };

      // /exit special case
      if (input === '/exit' || input === '/quit') {
        onExit?.();
        exit();
        return;
      }

      // /clear — reset messages
      if (input === '/clear') {
        setMessages([]);
        setToolCalls([]);
        return;
      }

      // /domain <name> — update domain state
      if (input.startsWith('/domain ')) {
        const newDomain = input.slice(8).trim();
        if (newDomain) setDomain(newDomain);
      }

      const handled = await handleSlash(input, slashCtx).catch(() => false);
      if (!handled) {
        setInfoLine(`Unknown command: ${input}`);
        setTimeout(() => setInfoLine(null), 3000);
      }
      return;
    }

    // ── LLM path ──────────────────────────────────────────────────────────
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: input, timestamp: new Date().toISOString() },
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
        event: 'pre_prompt', prompt: input, cwd: process.cwd(),
      }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

      let finalInput = input;
      if (!hookCtx.proceed) {
        setInfoLine(`[hook] Blocked: ${hookCtx.value ?? 'no reason given'}`);
        setIsStreaming(false);
        abortRef.current = null;
        return;
      }
      if (hookCtx.injection) {
        finalInput = `${input}\n\n---\n${hookCtx.injection}`;
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
        const { estimateHistoryTokens } = await import('../../core/context/context-compressor.js').catch(() => ({ estimateHistoryTokens: () => 0 }));
        const h = agent.getHistory();
        const est = typeof estimateHistoryTokens === 'function'
          ? (estimateHistoryTokens as (h: unknown[]) => number)(h)
          : 0;
        setStatusInfo((s) => ({ ...s, estimatedTokens: est }));
      } catch { /* non-fatal */ }
    }
  }, [agent, domain, sessionId, appendAssistant, exit, onExit, inferProviderEnvKey]);

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
  if (initialPrompt && !firedInitial.current) {
    firedInitial.current = true;
    // Defer to after first render
    Promise.resolve().then(() => handleSubmit(initialPrompt)).catch(() => {});
  }

  const currentModel = modelManager.getCurrentModel('main');

  return (
    <Box flexDirection="column" height="100%">
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {messages.length === 0 && (
          <Box paddingY={1} paddingLeft={2} flexDirection="column">
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
          {toolCalls.map((tc) => (
            <ToolCallLine key={tc.id} call={tc} />
          ))}
        </Box>
      )}

      {/* Info line (flash messages) */}
      {infoLine && (
        <Box paddingLeft={2}>
          <Text color="yellow" dimColor>{infoLine}</Text>
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
