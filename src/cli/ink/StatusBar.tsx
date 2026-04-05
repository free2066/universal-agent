/**
 * StatusBar — compact bottom info line.
 *
 * Format:
 *   [domain/model | thinking: low] | project | sentTokens | sessionTokens/maxCtx (pct%) | sessionId
 *
 * Fields:
 *   1. [domain/model]           — bracket group; thinking appended when active
 *   2. project                  — basename(cwd)
 *   3. sentTokens               — tokens actually sent to model (post-compact)
 *   4. sessionTokens/maxCtx(%)  — raw session size / model max context
 *   5. sessionId                — first 8 chars
 */

import React from 'react';
import { Box, Text } from 'ink';
import { basename } from 'path';

export interface StatusBarProps {
  model: string;
  domain: string;
  sessionId: string;
  /** Tokens sent to model (post-compact, what the LLM actually sees) */
  estimatedTokens?: number;
  /** Raw session token total (all messages, pre-compact) */
  sessionTokens?: number;
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
  sessionTokens,
  contextLength = 128000,
  isThinking = 'none',
  mode,
}: StatusBarProps): React.JSX.Element {
  const project  = basename(process.cwd());
  const shortId  = sessionId.slice(0, 8);

  // Sent-to-model tokens (post-compact)
  const hasSent  = estimatedTokens > 0;

  // Session tokens / context ratio
  const sessTokens = sessionTokens ?? estimatedTokens;  // fallback to estimatedTokens if not provided
  const pct        = contextLength > 0 ? Math.round((sessTokens / contextLength) * 100) : 0;
  const pctCapped  = Math.min(pct, 100);
  const tknColor   = tokenColor(pctCapped);
  const hasSession = sessTokens > 0;

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

      {/* 3. sent tokens — what model actually received (post-compact) */}
      {hasSent ? (
        <>
          {SEP}
          <Text color="white">{fmtN(estimatedTokens)}</Text>
        </>
      ) : null}

      {/* 4. session/max (pct%) — raw session size vs model context limit */}
      {hasSession ? (
        <>
          {SEP}
          <Text color={tknColor}>{fmtN(sessTokens)}</Text>
          <Text color="gray" dimColor>/</Text>
          <Text color={tknColor}>{fmtN(contextLength)}</Text>
          <Text color={tknColor} dimColor>{` (${pctCapped}%)`}</Text>
        </>
      ) : null}

      {SEP}

      {/* 5. session ID */}
      <Text color="gray" dimColor>{shortId}</Text>

    </Box>
  );
}
