/**
 * MessageList — scrollable history of chat messages.
 *
 * Renders the agent conversation history.
 * Kept simple: no full virtualization (Ink doesn't support scroll),
 * but limits visible messages to the last N to avoid terminal overflow.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** ISO timestamp for display */
  timestamp?: string;
}

const MAX_VISIBLE = 20; // show last N messages

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function UserMessage({ msg }: { msg: ChatMessage }): React.JSX.Element {
  return (
    <Box flexDirection="row" paddingTop={1} gap={1}>
      <Text color="cyan" bold>you</Text>
      <Text color="gray">›</Text>
      <Text wrap="wrap">{msg.content}</Text>
    </Box>
  );
}

function AssistantMessage({ msg }: { msg: ChatMessage }): React.JSX.Element {
  // Truncate very long assistant messages in the history view
  const display = truncate(msg.content, 2000);
  return (
    <Box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <Box gap={1}>
        <Text color="green" bold>agent</Text>
        <Text color="gray">›</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{display}</Text>
      </Box>
    </Box>
  );
}

export function MessageList({ messages }: { messages: ChatMessage[] }): React.JSX.Element {
  const visible = messages.slice(-MAX_VISIBLE);
  const hidden = messages.length - visible.length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {hidden > 0 && (
        <Box paddingBottom={1}>
          <Text color="gray" dimColor>... {hidden} earlier messages (use /compact to trim)</Text>
        </Box>
      )}
      {visible.map((msg, idx) => {
        const key = `${msg.role}-${idx}`;
        if (msg.role === 'user') return <UserMessage key={key} msg={msg} />;
        if (msg.role === 'assistant') return <AssistantMessage key={key} msg={msg} />;
        // system/tool messages rendered dimmed
        return (
          <Box key={key} paddingTop={1}>
            <Text color="gray" dimColor>[{msg.role}] {truncate(msg.content, 120)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
