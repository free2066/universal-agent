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

type ThinkingInfo = {
  label: string;
  color: 'cyan' | 'yellow' | 'magenta';
} | null;

/** Matches readline statusbar.ts _thinkingPart: low=cyan, medium=yellow, high=magenta */
function thinkingInfo(level: StatusBarProps['isThinking']): ThinkingInfo {
  switch (level) {
    case 'low':    return { label: ' thinking...', color: 'cyan' };
    case 'medium': return { label: ' thinking...', color: 'yellow' };
    case 'high':   return { label: ' thinking...', color: 'magenta' };
    default: return null;
  }
}

/** Token percentage color: ≥85%=red, ≥60%=yellow, <60%=green — matches readline _ctxColor */
function tokenColor(pct: number): 'red' | 'yellow' | 'green' {
  if (pct >= 85) return 'red';
  if (pct >= 60) return 'yellow';
  return 'green';
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
  const pctCapped = Math.min(pct, 100);
  const hasTokens = estimatedTokens > 0;
  const tknColor = tokenColor(pctCapped);
  const modeStr = mode && mode !== 'default' ? ` [${mode}]` : '';
  const thinking = thinkingInfo(isThinking);

  return (
    <Box flexDirection="row" gap={1} paddingLeft={1}>
      <Text color="cyan" bold>{domain}</Text>
      <Text color="gray">·</Text>
      <Text color="white">{model}</Text>
      {modeStr ? <Text color="yellow">{modeStr}</Text> : null}
      {thinking ? <Text color={thinking.color} dimColor>{thinking.label}</Text> : null}
      {hasTokens ? (
        <>
          <Text color="gray">·</Text>
          <Text color={tknColor}>{estimatedTokens.toLocaleString()}/{(contextLength / 1000).toFixed(0)}k</Text>
          <Text color={tknColor} dimColor>({pctCapped}%)</Text>
        </>
      ) : null}
      <Text color="gray">·</Text>
      <Text color="gray" dimColor>#{sessionId.slice(0, 8)}</Text>
    </Box>
  );
}
