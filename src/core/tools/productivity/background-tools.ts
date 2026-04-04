/**
 * background_run / check_background tools — s08-style non-blocking execution.
 *
 * background_run: spawn a command in a background child process, returns task_id immediately.
 * check_background: poll status of one or all background tasks.
 *
 * Results are automatically injected into the conversation before the next LLM call
 * via backgroundManager.drainNotifications() in the agent loop.
 *
 * s08 motto: "Fire and forget — the agent doesn't block while the command runs."
 */

import type { ToolRegistration } from '../../../models/types.js';
import { backgroundManager } from '../../background-manager.js';

export const backgroundRunTool: ToolRegistration = {
  definition: {
    name: 'background_run',
    description: [
      'Run a shell command in the background (non-blocking).',
      'Returns a task_id immediately — the agent can continue working while the command runs.',
      'Results are automatically injected into the conversation when the command completes.',
      'Use for long-running commands: npm test, npm run build, long compilations, etc.',
      'Use check_background to manually poll status at any time.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run in the background.',
        },
      },
      required: ['command'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    if (!command || typeof command !== 'string') {
      return 'Error: "command" parameter is required.';
    }
    return backgroundManager.run(command, process.cwd());
  },
};

export const checkBackgroundTool: ToolRegistration = {
  definition: {
    name: 'check_background',
    description: [
      'Check the status of one background task (pass task_id) or list all tasks (omit task_id).',
      'Returns: [running|completed|timeout|error] status and output when available.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'Background task ID returned by background_run. Omit to list all tasks.',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    return backgroundManager.check(args.task_id as string | undefined);
  },
};

export const killBashTool: ToolRegistration = {
  definition: {
    name: 'kill_bash',
    description: [
      'Terminate a running background task started by background_run.',
      'Sends SIGTERM to the process; escalates to SIGKILL after 3 s if still alive.',
      'Has no effect if the task has already completed or does not exist.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'Background task ID returned by background_run.',
        },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const taskId = args.task_id as string;
    if (!taskId || typeof taskId !== 'string') {
      return 'Error: "task_id" parameter is required.';
    }
    return backgroundManager.kill(taskId);
  },
};
