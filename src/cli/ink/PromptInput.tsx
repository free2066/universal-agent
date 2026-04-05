/**
 * PromptInput — the user input box at the bottom of the REPL.
 *
 * Features:
 * - Multi-line support (\ continuation)
 * - History navigation (Up/Down)
 * - Esc to abort streaming
 * - Tab completion for /slash commands
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PromptInputProps {
  domain: string;
  mode?: string;
  isStreaming: boolean;
  onSubmit: (value: string) => void;
  onAbort?: () => void;
  historyItems?: string[];
  slashCompletions?: string[];
  /** @file fuzzy completions (relative paths from cwd) */
  fileCompletions?: string[];
  /** @run-agent-xxx completions */
  agentCompletions?: string[];
  // Ctrl+R reverse-search
  historySearch?: boolean;
  historySearchMatch?: string | null;
  onHistorySearchInput?: (ch: string, isBackspace: boolean) => void;
  onHistorySearchAccept?: (val: string | null) => void;
  onHistorySearchCancel?: () => void;
  /** Called whenever the current input value changes (used by Ctrl+G to pre-populate editor) */
  onValueChange?: (val: string) => void;
  /** External value injection — when set, overrides the internal input state (used by Ctrl+G backfill) */
  externalValue?: string;
}

const MODE_COLORS: Record<string, string> = {
  default: 'cyan',
  plan: 'yellow',
  brainstorm: 'magenta',
  'auto-edit': 'red',
};

export function PromptInput({
  domain,
  mode = 'default',
  isStreaming,
  onSubmit,
  onAbort,
  historyItems = [],
  slashCompletions = [],
  fileCompletions = [],
  agentCompletions = [],
  historySearch = false,
  historySearchMatch = null,
  onHistorySearchInput,
  onHistorySearchAccept,
  onHistorySearchCancel,
  onValueChange,
  externalValue,
}: PromptInputProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [pendingLines, setPendingLines] = useState<string[]>([]);
  const [isMultiline, setIsMultiline] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // Guard: prevent double-submit from rapid key events
  const lastSubmitTime = useRef(0);

  // Paste batching: buffer for coalescing rapid character input
  const pasteBuffer = useRef('');
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const promptColor = MODE_COLORS[mode] ?? 'cyan';

  // Update inline suggestion based on current value
  const updateSuggestion = useCallback((val: string) => {
    // /slash completions
    if (val.startsWith('/') && slashCompletions.length > 0) {
      const match = slashCompletions.find((c) => c.startsWith(val) && c !== val);
      setSuggestion(match ? match.slice(val.length) : null);
      return;
    }
    // @file / @agent completions — find last @token in the input
    const atMatch = val.match(/@([^\s]*)$/);
    if (atMatch) {
      const query = atMatch[1] ?? '';
      // Try @run-agent-xxx first
      const agentMatch = agentCompletions.find((a) => a.startsWith(query) && a !== query);
      if (agentMatch) {
        setSuggestion(agentMatch.slice(query.length));
        return;
      }
      // Then @file
      const fileMatch = fileCompletions.find((f) => f.toLowerCase().includes(query.toLowerCase()) && f !== query);
      if (fileMatch) {
        setSuggestion(fileMatch.slice(query.length));
        return;
      }
    }
    setSuggestion(null);
  }, [slashCompletions, fileCompletions, agentCompletions]);

  // External value injection: when Ctrl+G backfills edited content into the input box
  // (readline parity: repl.ts refills rl.line after editor exits, letting user edit before submit)
  useEffect(() => {
    if (externalValue !== undefined) {
      setValue(externalValue);
      updateSuggestion(externalValue);
    }
  }, [externalValue, updateSuggestion]);

  useInput((input, key) => {
    // ── Ctrl+R search mode input handling ─────────────────────────────────
    if (historySearch) {
      if (key.return) {
        onHistorySearchAccept?.(historySearchMatch ?? null);
        return;
      }
      if (key.escape || (key.ctrl && input === 'c')) {
        onHistorySearchCancel?.();
        return;
      }
      if (key.backspace || key.delete) {
        onHistorySearchInput?.('', true);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        onHistorySearchInput?.(input, false);
        return;
      }
      return; // eat all other keys in search mode
    }

    // Streaming: only allow Esc to abort
    if (isStreaming) {
      if (key.escape && onAbort) {
        onAbort();
      }
      return;
    }

    // Esc: clear input (when not streaming)
    if (key.escape) {
      setValue('');
      setHistoryIdx(-1);
      setSuggestion(null);
      setPendingLines([]);
      setIsMultiline(false);
      return;
    }

    // Enter: submit
    if (key.return) {
      // Debounce: ignore if last submit was < 100ms ago
      const now = Date.now();
      if (now - lastSubmitTime.current < 100) return;

      // Multi-line continuation: line ends with backslash
      if (value.endsWith('\\')) {
        const seg = value.slice(0, -1);
        setPendingLines((prev) => [...prev, seg]);
        setIsMultiline(true);
        setValue('');
        setSuggestion(null);
        onValueChange?.('');
        return;
      }

      // Build final input
      let finalInput: string;
      if (isMultiline || pendingLines.length > 0) {
        const lines = [...pendingLines, value].filter(Boolean);
        finalInput = lines.join('\n').trim();
        setPendingLines([]);
        setIsMultiline(false);
      } else {
        finalInput = value.trim();
      }

      if (finalInput) {
        lastSubmitTime.current = now;
        setValue('');
        setHistoryIdx(-1);
        setSuggestion(null);
        onSubmit(finalInput);
      }
      return;
    }

    // Tab: accept suggestion
    if (key.tab) {
      if (suggestion) {
        const completed = value + suggestion;
        setValue(completed);
        setSuggestion(null);
        updateSuggestion(completed);
      }
      return;
    }

    // Up: navigate history back
    if (key.upArrow) {
      if (historyItems.length === 0) return;
      const newIdx = Math.min(historyIdx + 1, historyItems.length - 1);
      setHistoryIdx(newIdx);
      const histVal = historyItems[historyItems.length - 1 - newIdx] ?? '';
      setValue(histVal);
      updateSuggestion(histVal);
      return;
    }

    // Down: navigate history forward
    if (key.downArrow) {
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setValue('');
        setSuggestion(null);
        return;
      }
      const newIdx = historyIdx - 1;
      setHistoryIdx(newIdx);
      const histVal = historyItems[historyItems.length - 1 - newIdx] ?? '';
      setValue(histVal);
      updateSuggestion(histVal);
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      const newVal = value.slice(0, -1);
      setValue(newVal);
      updateSuggestion(newVal);
      onValueChange?.(newVal);
      return;
    }

    // ── Line-editing shortcuts (readline parity) ──────────────────────────
    // Ctrl+W: delete last word (up to previous space)
    if (key.ctrl && input === 'w') {
      const trimmed = value.trimEnd();
      const lastSpace = trimmed.lastIndexOf(' ');
      const newVal = lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : '';
      setValue(newVal);
      updateSuggestion(newVal);
      return;
    }
    // Ctrl+U: clear entire line
    if (key.ctrl && input === 'u') {
      setValue('');
      setSuggestion(null);
      return;
    }
    // Ctrl+K: clear from cursor to end (cursor always at end in Ink)
    if (key.ctrl && input === 'k') {
      setValue('');
      setSuggestion(null);
      return;
    }
    // Ctrl+A: line start — noop in Ink (no cursor positioning), but consume event
    if (key.ctrl && input === 'a') return;
    // Ctrl+E: line end — already at end in Ink, consume event
    if (key.ctrl && input === 'e') return;

    // Regular character input — ignore control/meta sequences
    if (input && !key.ctrl && !key.meta) {
      // Paste batching: defer update to coalesce rapid character bursts
      pasteBuffer.current += input;
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      pasteTimer.current = setTimeout(() => {
        const batch = pasteBuffer.current;
        pasteBuffer.current = '';
        pasteTimer.current = null;
        setValue((prev) => {
          const newVal = prev + batch;
          updateSuggestion(newVal);
          onValueChange?.(newVal);
          return newVal;
        });
      }, 16); // ~1 frame, batches rapid paste events
    }
  });

  const displayPrompt = isMultiline
    ? '... '
    : mode !== 'default'
      ? `[${mode}] ❯ `
      : `${domain} ❯ `;

  return (
    <Box flexDirection="column">
      {/* Pending multiline segments */}
      {isMultiline && pendingLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {pendingLines.map((line, i) => (
            <Text key={i} color="gray" dimColor>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row">
        <Text color={promptColor as Parameters<typeof Text>[0]['color']} bold>
          {isStreaming ? `${domain} ◌ ` : displayPrompt}
        </Text>
        <Text>{value}</Text>
        {suggestion && !isStreaming && (
          <Text color="gray" dimColor>{suggestion}</Text>
        )}
        {!isStreaming && (
          <Text color={promptColor as Parameters<typeof Text>[0]['color']}>▊</Text>
        )}
      </Box>
    </Box>
  );
}
