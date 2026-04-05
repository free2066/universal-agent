/**
 * ToolCallLine — a single tool call status line.
 *
 * Shows: tool name + args preview while running,
 *        ↳ done/failed + duration after completion.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface ToolCallInfo {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
}

export function ToolCallLine({ call }: { call: ToolCallInfo }): React.JSX.Element {
  const durStr = call.durationMs !== undefined
    ? call.durationMs < 1000
      ? `${call.durationMs}ms`
      : `${(call.durationMs / 1000).toFixed(1)}s`
    : '';

  if (call.status === 'running') {
    return (
      <Box>
        <Text color="cyan" bold>{call.name}</Text>
        {call.args && <Text color="gray" dimColor>({call.args})</Text>}
        <Text> </Text>
        <Spinner type="dots" />
      </Box>
    );
  }

  const resultLine = call.status === 'done'
    ? <Text color="gray" dimColor>↳ done{durStr ? ` (${durStr})` : ''}.</Text>
    : <Text color="red">↳ failed{durStr ? ` (${durStr})` : ''}.</Text>;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{call.name}</Text>
        {call.args && <Text color="gray" dimColor>({call.args})</Text>}
      </Box>
      <Box paddingLeft={0}>
        {resultLine}
      </Box>
    </Box>
  );
}
