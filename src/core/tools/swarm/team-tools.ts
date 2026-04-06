/**
 * team-tools.ts -- E24: TeamCreate/TeamDeleteTool (LLM-callable Swarm team management)
 *
 * E24: Mirrors claude-code src/tools/TeamCreateTool/TeamCreateTool.ts L74-L241
 *      and src/tools/TeamDeleteTool/TeamDeleteTool.ts L1-L140
 *
 * Design:
 *   - team_create: Creates a named team, writes .uagent/teams/<teamName>.json,
 *     spawns specified agents via TeammateManager.spawn().
 *   - team_delete: Disbands a team by sending shutdown_request to all members
 *     and cleaning up .uagent/teams/<teamName>.json.
 *
 * Team file format:
 *   .uagent/teams/<teamName>.json  {
 *     "teamName": "...",
 *     "description": "...",
 *     "leadSessionId": "...",
 *     "members": [{ "name": "alice", "role": "coder", "domain": "auto" }],
 *     "createdAt": 1234567890000
 *   }
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

// ── Team file helpers ─────────────────────────────────────────────────────────

interface TeamMemberConfig {
  name: string;
  role: string;
  domain?: string;
  prompt?: string;
}

interface TeamFile {
  teamName: string;
  description?: string;
  leadSessionId?: string;
  members: TeamMemberConfig[];
  createdAt: number;
}

function getTeamsDir(projectRoot?: string): string {
  return join(resolve(projectRoot ?? process.cwd()), '.uagent', 'teams');
}

function getTeamFilePath(teamName: string, projectRoot?: string): string {
  return join(getTeamsDir(projectRoot), `${teamName}.json`);
}

function readTeamFile(teamName: string, projectRoot?: string): TeamFile | null {
  const path = getTeamFilePath(teamName, projectRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TeamFile;
  } catch {
    return null;
  }
}

function writeTeamFile(teamFile: TeamFile, projectRoot?: string): void {
  const teamsDir = getTeamsDir(projectRoot);
  mkdirSync(teamsDir, { recursive: true });
  writeFileSync(
    getTeamFilePath(teamFile.teamName, projectRoot),
    JSON.stringify(teamFile, null, 2),
    'utf-8',
  );
}

// ── E24: teamCreateTool ───────────────────────────────────────────────────────

export const teamCreateTool: ToolRegistration = {
  definition: {
    name: 'team_create',
    description: [
      'Create a team of sub-agents for parallel task execution in a swarm.',
      'Spawns specified agents via the teammate system.',
      'Each agent gets its own LLM loop and can communicate via send_message.',
      'Returns the team configuration with all spawned agent names.',
      'Use send_message to assign work to spawned agents.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        team_name: {
          type: 'string',
          description: 'Unique team name (alphanumeric and hyphens, e.g. "backend-team")',
        },
        description: {
          type: 'string',
          description: 'Team purpose and goals (shown to all agents as context)',
        },
        members: {
          type: 'array',
          description: 'List of agent configurations to spawn',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Agent name (e.g. "alice")' },
              role: { type: 'string', description: 'Agent role description (e.g. "TypeScript coder")' },
              prompt: { type: 'string', description: 'Initial task prompt for this agent' },
              domain: { type: 'string', description: 'Domain for this agent (default: "auto")' },
            },
            required: ['name', 'role'],
          },
        },
      },
      required: ['team_name', 'members'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const teamName = args['team_name'] as string;
    const description = (args['description'] as string | undefined) ?? '';
    const members = (args['members'] as TeamMemberConfig[] | undefined) ?? [];

    if (!teamName || !/^[a-zA-Z0-9_\-]+$/.test(teamName)) {
      return 'Error: team_name must be alphanumeric with hyphens/underscores only';
    }
    if (members.length === 0) {
      return 'Error: members array must not be empty';
    }

    // Check for duplicate team
    if (readTeamFile(teamName)) {
      return `Error: Team "${teamName}" already exists. Use team_delete first to recreate it.`;
    }

    // Write team file
    const teamFile: TeamFile = {
      teamName,
      description,
      leadSessionId: process.pid.toString(),
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        domain: m.domain ?? 'auto',
        prompt: m.prompt ?? '',
      })),
      createdAt: Date.now(),
    };
    writeTeamFile(teamFile);

    // Spawn agents via TeammateManager
    const { getTeammateManager } = await import('../../teammate-manager.js');
    const mgr = getTeammateManager(process.cwd());
    const spawned: string[] = [];
    const failed: string[] = [];

    for (const member of members) {
      const prompt = member.prompt
        ? `${member.prompt}\n\nYou are part of team "${teamName}": ${description}`
        : `You are part of team "${teamName}": ${description}. Await task assignments via send_message.`;

      const result = mgr.spawn(member.name, member.role, prompt);
      if (result.startsWith('Error:')) {
        failed.push(`${member.name}: ${result}`);
      } else {
        spawned.push(member.name);
      }
    }

    const lines = [
      `Team "${teamName}" created.`,
      `Description: ${description || '(none)'}`,
      `Spawned agents (${spawned.length}): ${spawned.join(', ')}`,
    ];
    if (failed.length > 0) {
      lines.push(`Failed to spawn (${failed.length}): ${failed.join('; ')}`);
    }
    lines.push(`Use send_message to assign tasks to team members.`);
    lines.push(`Use team_delete to disband the team when done.`);

    return lines.join('\n');
  },
};

// ── E24: teamDeleteTool ───────────────────────────────────────────────────────

export const teamDeleteTool: ToolRegistration = {
  definition: {
    name: 'team_delete',
    description: [
      'Disband a team and request all its sub-agents to shut down gracefully.',
      'Sends a shutdown_request to each team member via their inbox.',
      'Removes the team file from .uagent/teams/.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        team_name: {
          type: 'string',
          description: 'Name of the team to delete',
        },
        force: {
          type: 'boolean',
          description: 'If true, delete team file even if agents do not acknowledge shutdown',
        },
      },
      required: ['team_name'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const teamName = args['team_name'] as string;

    const teamFile = readTeamFile(teamName);
    if (!teamFile) {
      return `Error: Team "${teamName}" not found.`;
    }

    // Send shutdown_request to all members via MessageBus
    const { getTeammateManager } = await import('../../teammate-manager.js');
    const mgr = getTeammateManager(process.cwd());
    const notified: string[] = [];

    for (const member of teamFile.members) {
      const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      mgr.bus.send(
        'lead',
        member.name,
        `Team "${teamName}" is being disbanded. Please shut down gracefully.`,
        'shutdown_request',
        { request_id: reqId },
      );
      notified.push(member.name);
    }

    // Remove team file
    const teamFilePath = getTeamFilePath(teamName);
    try {
      unlinkSync(teamFilePath);
    } catch {
      return `Warning: Sent shutdown to ${notified.length} agents but could not remove team file.`;
    }

    return [
      `Team "${teamName}" disbanded.`,
      `Shutdown requested for ${notified.length} agent(s): ${notified.join(', ')}`,
      `Team file removed.`,
    ].join('\n');
  },
};
