/**
 * StatusBar — fixed bottom bar showing model / domain / token info.
 *
 * Replaces the readline-prompt-embedded status bar from statusbar.ts.
 * Renders as a single sticky row at the bottom of the terminal.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  model: string;
  domain: string;
  sessionId: string;
  estimatedTokens?: number;
  contextLength?: number;
  isThinking?: 'none' | 'low' | 'medium' | 'high';
  mode?: string;
}

function thinkingLabel(level: StatusBarProps['isThinking']): string {
  switch (level) {
    case 'low': return ' thinking...';
    case 'medium': return ' thinking...';
    case 'high': return ' thinking...';
    default: return '';
  }
}

export function StatusBar({
  model,
  domain,
  sessionId,
  estimatedTokens = 0,
  contextLength = 128000,
  isThinking = 'none',
  mode,
}: StatusBarProps): React.JSX.Element {
  const pct = contextLength > 0 ? Math.round((estimatedTokens / contextLength) * 100) : 0;
  const tokenStr = estimatedTokens > 0 ? ` ${estimatedTokens.toLocaleString()}/${(contextLength / 1000).toFixed(0)}k (${pct}%)` : '';
  const modeStr = mode && mode !== 'default' ? ` [${mode}]` : '';
  const thinkStr = thinkingLabel(isThinking);

  return (
    <Box borderStyle="single" borderColor="gray" paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        <Text color="cyan" bold>{domain}</Text>
        <Text color="gray">·</Text>
        <Text color="white">{model}</Text>
        {modeStr && <Text color="yellow">{modeStr}</Text>}
        {thinkStr && <Text color="yellow" dimColor>{thinkStr}</Text>}
      </Box>
      <Box flexDirection="row" gap={1}>
        {tokenStr && <Text color="gray">{tokenStr}</Text>}
        <Text color="gray" dimColor>#{sessionId}</Text>
      </Box>
    </Box>
  );
}
