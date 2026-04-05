/**
 * StatusBar — fixed bottom bar showing model / domain / token info.
 *
 * Format (matches screenshot reference):
 *   [domain/model | thinking: low] | project | 1.71M | 76% | ID session
 */

import React from 'react';
import { Box, Text } from 'ink';
import { basename } from 'path';

export interface StatusBarProps {
  model: string;
  domain: string;
  sessionId: string;
  estimatedTokens?: number;
  contextLength?: number;
  isThinking?: 'none' | 'low' | 'medium' | 'high';
  mode?: string;
}

/** Token percentage color: ≥85%=red, ≥60%=yellow, <60%=green */
function tokenColor(pct: number): 'red' | 'yellow' | 'green' {
  if (pct >= 85) return 'red';
  if (pct >= 60) return 'yellow';
  return 'green';
}

/** Format token count: ≥1M → "1.71M", else → "128k" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const SEP = <Text color="gray" dimColor> | </Text>;

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
  const project = basename(process.cwd());
  const shortId = sessionId.slice(0, 8);

  // Left bracket group: [domain/model | thinking: level]
  const thinkingPart = isThinking && isThinking !== 'none'
    ? ` | thinking: ${isThinking}`
    : '';

  return (
    <Box flexDirection="row" paddingLeft={1} paddingTop={0}>
      {/* [domain/model | thinking] */}
      <Text color="gray" dimColor>[</Text>
      <Text color="cyan" bold>{domain}</Text>
      <Text color="gray" dimColor>/</Text>
      <Text color="white">{model}</Text>
      {thinkingPart ? <Text color="yellow" dimColor>{thinkingPart}</Text> : null}
      {mode && mode !== 'default' ? <Text color="yellow" dimColor> | {mode}</Text> : null}
      <Text color="gray" dimColor>]</Text>

      {SEP}

      {/* project name */}
      <Text color="gray">{project}</Text>

      {/* tokens */}
      {hasTokens ? (
        <>
          {SEP}
          <Text color={tknColor}>{fmtTokens(estimatedTokens)}</Text>
          {SEP}
          <Text color={tknColor} bold={pctCapped >= 60}>{pctCapped}%</Text>
        </>
      ) : null}

      {SEP}

      {/* session ID */}
      <Text color="gray" dimColor>ID </Text>
      <Text color="gray">{shortId}</Text>
    </Box>
  );
}
