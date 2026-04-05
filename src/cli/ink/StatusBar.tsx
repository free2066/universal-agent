/**
 * StatusBar — compact bottom info line.
 *
 * Format:
 *   [domain/model | thinking: low] | project | 68k | 68k/1000k (6%) | 5d594633
 *
 * Fields (in order):
 *   1. [domain/model]  — bracket group; | thinking: level appended when active
 *   2. project         — basename(cwd)
 *   3. usedTokens      — e.g. "68k" or "1.71M"
 *   4. used/max (pct%) — e.g. "68k/1000k (6%)"  — color-coded by pct
 *   5. sessionId       — first 8 chars
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

/** ≥85% red, ≥60% yellow, else green */
function tokenColor(pct: number): 'red' | 'yellow' | 'green' {
  if (pct >= 85) return 'red';
  if (pct >= 60) return 'yellow';
  return 'green';
}

/** 1_500_000 → "1.5M"  |  128_000 → "128k"  |  500 → "500" */
function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
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
  const pct      = contextLength > 0 ? Math.round((estimatedTokens / contextLength) * 100) : 0;
  const pctCapped = Math.min(pct, 100);
  const tknColor = tokenColor(pctCapped);
  const project  = basename(process.cwd());
  const shortId  = sessionId.slice(0, 8);
  const hasTokens = estimatedTokens > 0;

  const usedStr  = fmtN(estimatedTokens);           // e.g. "68k"
  const maxStr   = fmtN(contextLength);              // e.g. "1000k"

  return (
    <Box flexDirection="row" paddingLeft={1}>

      {/* 1. [domain/model | thinking: level | mode] */}
      <Text color="gray" dimColor>[</Text>
      <Text color="cyan" bold>{domain}</Text>
      <Text color="gray" dimColor>/</Text>
      <Text color="white">{model}</Text>
      {isThinking && isThinking !== 'none'
        ? <Text color="yellow" dimColor>{` | thinking: ${isThinking}`}</Text>
        : null}
      {mode && mode !== 'default'
        ? <Text color="yellow" dimColor>{` | ${mode}`}</Text>
        : null}
      <Text color="gray" dimColor>]</Text>

      {SEP}

      {/* 2. project name */}
      <Text color="gray">{project}</Text>

      {/* 3. already-used tokens  (only when >0) */}
      {hasTokens ? (
        <>
          {SEP}
          <Text color={tknColor}>{usedStr}</Text>
        </>
      ) : null}

      {/* 4. used/max (pct%)  (only when >0) */}
      {hasTokens ? (
        <>
          {SEP}
          <Text color={tknColor}>{usedStr}/{maxStr}</Text>
          <Text color={tknColor} dimColor>{` (${pctCapped}%)`}</Text>
        </>
      ) : null}

      {SEP}

      {/* 5. session ID */}
      <Text color="gray" dimColor>{shortId}</Text>

    </Box>
  );
}
