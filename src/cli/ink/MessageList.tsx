/**
 * MessageList — virtualized-style message history for Ink terminal.
 *
 * Ink doesn't support real DOM virtualization, so we implement a
 * "window" approach: only render a fixed-size window of messages,
 * controlled by scrollOffset prop.  Messages outside the window are
 * replaced by a compact summary line.
 *
 * Keyboard scrolling (PageUp/PageDown) is handled in App.tsx which
 * passes the scrollOffset state down here.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** ISO timestamp for display */
  timestamp?: string;
}

/** How many messages to show in the visible window */
export const MSG_WINDOW_SIZE = 30;
/** Max chars to show per assistant message before truncating */
const MAX_ASSISTANT_CHARS = 6000;
/** Max lines to show per assistant message */
const MAX_ASSISTANT_LINES = 80;

function truncateAssistant(text: string): { display: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length > MAX_ASSISTANT_LINES) {
    return {
      display: lines.slice(0, MAX_ASSISTANT_LINES).join('\n'),
      truncated: true,
    };
  }
  if (text.length > MAX_ASSISTANT_CHARS) {
    return {
      display: text.slice(0, MAX_ASSISTANT_CHARS),
      truncated: true,
    };
  }
  return { display: text, truncated: false };
}

function UserMessage({ msg }: { msg: ChatMessage }): React.JSX.Element {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="cyan" bold>you</Text>
      <Text color="gray">›</Text>
      <Text wrap="wrap">{msg.content}</Text>
    </Box>
  );
}

function AssistantMessage({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const { display, truncated } = truncateAssistant(msg.content);
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color="green" bold>agent</Text>
        <Text color="gray">›</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{display}</Text>
      </Box>
      {truncated && (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            ... ({msg.content.length - display.length} chars hidden — full content in session log)
          </Text>
        </Box>
      )}
    </Box>
  );
}

export interface MessageListProps {
  messages: ChatMessage[];
  /** Scroll offset from the end: 0 = show latest, 1 = scroll back 1 window, etc. */
  scrollOffset?: number;
}

export function MessageList({ messages, scrollOffset = 0 }: MessageListProps): React.JSX.Element {
  const total = messages.length;

  // Calculate visible window
  // scrollOffset=0 → show last MSG_WINDOW_SIZE
  // scrollOffset=1 → show MSG_WINDOW_SIZE before last window, etc.
  const windowEnd = Math.max(0, total - scrollOffset * Math.floor(MSG_WINDOW_SIZE / 2));
  const windowStart = Math.max(0, windowEnd - MSG_WINDOW_SIZE);
  const visible = messages.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {hiddenAbove > 0 && (
        <Box paddingBottom={1}>
          <Text color="gray" dimColor>
            ↑ {hiddenAbove} earlier message{hiddenAbove !== 1 ? 's' : ''} hidden
            {scrollOffset > 0 ? ' — PgDn to scroll down' : ' — PgUp to scroll up'}
          </Text>
        </Box>
      )}

      {visible.map((msg, idx) => {
        const key = `${msg.role}-${windowStart + idx}`;
        if (msg.role === 'user') return <UserMessage key={key} msg={msg} />;
        if (msg.role === 'assistant') return <AssistantMessage key={key} msg={msg} />;
        return (
          <Box key={key}>
            <Text color="gray" dimColor>{msg.content}</Text>
          </Box>
        );
      })}

      {hiddenBelow > 0 && (
        <Box paddingTop={1}>
          <Text color="gray" dimColor>
            ↓ {hiddenBelow} newer message{hiddenBelow !== 1 ? 's' : ''} — PgDn to scroll down
          </Text>
        </Box>
      )}
    </Box>
  );
}
