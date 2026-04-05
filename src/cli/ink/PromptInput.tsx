/**
 * PromptInput — the user input box at the bottom of the REPL.
 *
 * Features:
 * - Multi-line support (\ continuation)
 * - History navigation (Up/Down)
 * - Esc to abort streaming
 * - Ctrl+C to exit
 * - Tab completion for /slash commands and @file refs
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PromptInputProps {
  domain: string;
  mode?: string;
  isStreaming: boolean;
  onSubmit: (value: string) => void;
  onAbort?: () => void;
  historyItems?: string[];
  slashCompletions?: string[];
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
}: PromptInputProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [pendingLines, setPendingLines] = useState<string[]>([]);
  const [isMultiline, setIsMultiline] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const promptColor = MODE_COLORS[mode] ?? 'cyan';
  const promptChar = isStreaming ? '◌' : '❯';

  // Update inline suggestion based on current value
  const updateSuggestion = useCallback((val: string) => {
    if (val.startsWith('/') && slashCompletions.length > 0) {
      const match = slashCompletions.find((c) => c.startsWith(val) && c !== val);
      setSuggestion(match ? match.slice(val.length) : null);
    } else {
      setSuggestion(null);
    }
  }, [slashCompletions]);

  useInput((input, key) => {
    if (isStreaming) {
      if (key.escape && onAbort) {
        onAbort();
      }
      return;
    }

    // Esc: clear input
    if (key.escape) {
      setValue('');
      setHistoryIdx(-1);
      setSuggestion(null);
      return;
    }

    // Enter: submit
    if (key.return) {
      // Multi-line continuation: line ends with backslash
      if (value.endsWith('\\')) {
        const seg = value.slice(0, -1);
        setPendingLines((prev) => [...prev, seg]);
        setIsMultiline(true);
        setValue('');
        setSuggestion(null);
        return;
      }

      // End of multi-line input
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
        setValue('');
        setHistoryIdx(-1);
        setSuggestion(null);
        onSubmit(finalInput);
      }
      return;
    }

    // Tab: accept suggestion
    if (key.tab && suggestion) {
      const completed = value + suggestion;
      setValue(completed);
      setSuggestion(null);
      updateSuggestion(completed);
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

    // Backspace
    if (key.backspace || key.delete) {
      const newVal = value.slice(0, -1);
      setValue(newVal);
      updateSuggestion(newVal);
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      const newVal = value + input;
      setValue(newVal);
      updateSuggestion(newVal);
    }
  });

  const displayPrompt = isMultiline ? '... ' : (mode !== 'default' ? `[${mode}] ❯ ` : `${domain} ❯ `);

  return (
    <Box flexDirection="column">
      {isMultiline && pendingLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {pendingLines.map((line, i) => (
            <Text key={i} color="gray" dimColor>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row">
        <Text color={promptColor as Parameters<typeof Text>[0]['color']} bold>{displayPrompt}</Text>
        <Text>{value}</Text>
        {suggestion && <Text color="gray" dimColor>{suggestion}</Text>}
        {!isStreaming && <Text color={promptColor as Parameters<typeof Text>[0]['color']}>▊</Text>}
      </Box>
    </Box>
  );
}
