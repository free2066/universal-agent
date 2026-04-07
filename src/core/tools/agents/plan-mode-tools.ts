/**
 * plan-mode-tools.ts — EnterPlanMode / ExitPlanMode tools
 *
 * Mirrors claude-code's EnterPlanModeTool and ExitPlanModeV2Tool.
 *
 * Plan Mode is a special agent operating mode where:
 *   - The LLM plans what it WOULD do, but does NOT actually execute writes
 *   - Write operations (Bash/Write/Edit) are blocked or require explicit approval
 *   - The plan is reviewed by the user before execution
 *
 * Implementation:
 *   - Uses a process-level global flag `_planModeActive`
 *   - `EnterPlanMode` sets the flag and returns instructions for planning
 *   - `ExitPlanMode` clears the flag (optionally starting execution)
 *   - The permission-manager checks `isPlanModeActive()` to block write tools
 *
 * Round 6: claude-code EnterPlanMode/ExitPlanModeV2 parity
 */

import type { ToolRegistration } from '../../../models/types.js';

// ── Global plan mode state ────────────────────────────────────────────────────

let _planModeActive = false;
/**
 * E18: Pre-plan-mode approval mode (claude-code prePlanMode parity).
 * Saved when entering plan mode, restored when exiting.
 * Ensures exact permission mode restoration rather than hardcoding a default.
 */
let _prePlanApprovalMode: 'default' | 'autoEdit' | 'yolo' | undefined;

/** Returns true if plan mode is currently active */
export function isPlanModeActive(): boolean {
  return _planModeActive;
}

/** Activate plan mode, saving the current approval mode for later restoration */
export function enterPlanMode(currentApprovalMode?: 'default' | 'autoEdit' | 'yolo'): void {
  _planModeActive = true;
  _prePlanApprovalMode = currentApprovalMode;
}

/**
 * Deactivate plan mode.
 * @returns The approval mode that was active before plan mode (for restoration), or undefined.
 */
export function exitPlanMode(): 'default' | 'autoEdit' | 'yolo' | undefined {
  _planModeActive = false;
  const mode = _prePlanApprovalMode;
  _prePlanApprovalMode = undefined;
  return mode;
}

// ── EnterPlanMode tool ────────────────────────────────────────────────────────

export const enterPlanModeTool: ToolRegistration = {
  definition: {
    name: 'EnterPlanMode',
    description: [
      'Enter plan mode: analyze and describe what you WOULD do, without executing any changes.',
      '',
      'In plan mode:',
      '  - ONLY read operations are allowed (Read, LS, Grep, Glob, WebFetch, WebSearch)',
      '  - Write operations (Bash, Write, Edit, NotebookEdit) are blocked',
      '  - You should produce a detailed plan listing files to change and exact edits',
      '',
      'Use this tool when:',
      '  - The task is risky or irreversible and you want the user to review the plan first',
      '  - The user explicitly asked for a plan before execution',
      '  - You are uncertain about scope and want to discuss before acting',
      '',
      'After entering plan mode, call ExitPlanMode with the complete plan when ready.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for entering plan mode (shown to the user)',
        },
      },
      required: [],
    },
  },

  async handler(args: unknown): Promise<string> {
    const input = args as { reason?: string };
    const reason = input.reason?.trim();

    // E18: enterPlanMode() will receive approvalMode via contextModifier
    enterPlanMode();

    const lines = [
      '✅ Plan mode activated.',
      '',
      reason ? `Reason: ${reason}` : '',
      '',
      'Instructions:',
      '  1. Use Read, LS, Grep, Glob tools to explore the codebase',
      '  2. Build a complete plan listing every file change and exact edit',
      '  3. Call ExitPlanMode with your plan when ready for review',
      '  4. Write operations are blocked until plan mode is exited',
      '',
      'Note: The user will review your plan before you execute any changes.',
    ].filter((l) => l !== undefined);

    return lines.join('\n');
  },

  // A18 + E18: contextModifier saves current approvalMode so ExitPlanMode can restore it
  contextModifier(ctx) {
    enterPlanMode(ctx.approvalMode); // overwrite with correct approvalMode
    return { ...ctx, planModeActive: true };
  },
};

// ── ExitPlanMode tool ─────────────────────────────────────────────────────────

export const exitPlanModeTool: ToolRegistration = {
  definition: {
    name: 'ExitPlanMode',
    description: [
      'Exit plan mode and present your plan to the user for review.',
      '',
      'Call this after you have fully analyzed the codebase and built a complete plan.',
      'The plan will be shown to the user who can then approve execution.',
      '',
      'B27: Prefer reading the plan from .uagent/plan.md if it exists.',
      'Only pass the plan parameter if you have NOT written it to a file.',
      '',
      'Include in the plan:',
      '  - Summary of what will be changed and why',
      '  - List of files with the specific edits for each',
      '  - Estimated risk level (low/medium/high)',
      '  - Any prerequisites or dependencies',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan to present. If .uagent/plan.md exists, it will be used instead.',
        },
        title: {
          type: 'string',
          description: 'Short title for the plan (1 line)',
        },
      },
      required: [],
    },
  },

  async handler(args: unknown): Promise<string> {
    const input = args as { plan?: string; title?: string };
    const title = input.title?.trim();

    // B27: Prefer reading plan from .uagent/plan.md (claude-code ExitPlanModeV2 parity)
    // Mirrors ExitPlanModeV2Tool.ts L246-253: getPlan() reads from plan file first
    let plan = (input.plan ?? '').trim();
    const planFilePath = _getPlanFilePath();
    if (planFilePath) {
      try {
        const { readFileSync, existsSync } = await import('fs');
        if (existsSync(planFilePath)) {
          const filePlan = readFileSync(planFilePath, 'utf-8').trim();
          if (filePlan) {
            plan = filePlan;
          }
        }
      } catch { /* fallback to plan parameter */ }
    }

    if (!plan) {
      return '[ExitPlanMode] Error: plan is required. Either pass plan parameter or write to .uagent/plan.md';
    }

    exitPlanMode();

    // B27: teammate 流程 — 若当前是子 agent（有 parentAgentId），发送 plan_approval_request
    // Mirrors claude-code ExitPlanModeV2Tool.ts L264-312: isTeammate() && isPlanModeRequired()
    // Non-fatal: only available in swarm/multi-agent environments
    const parentAgentId = process.env['__UAGENT_PARENT_AGENT_ID'];
    if (parentAgentId) {
      try {
        // Use dynamic eval-based require to avoid TypeScript module resolution errors
        // (mailbox-manager only exists in swarm environments)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mailboxMod = require('../agents/mailbox-manager.js') as { mailboxManager?: { send: (id: string, msg: unknown) => Promise<void> } };
        if (mailboxMod?.mailboxManager) {
          await mailboxMod.mailboxManager.send(parentAgentId, {
            type: 'plan_approval_request',
            plan,
            title: title ?? '(untitled plan)',
            fromAgentId: process.env['__UAGENT_AGENT_ID'] ?? 'unknown',
            timestamp: Date.now(),
          });
          // B27: Set awaitingLeaderApproval flag (prevents continuation until leader approves)
          process.env['__UAGENT_AWAITING_LEADER_APPROVAL'] = '1';
          return [
            '📋 Plan submitted to parent agent for approval.',
            '',
            title ? `**${title}**\n` : '',
            plan,
            '',
            '⏳ Waiting for leader approval before proceeding.',
            'The parent agent will review and approve execution.',
          ].filter(Boolean).join('\n');
        }
      } catch { /* non-fatal: mailboxManager not available in non-swarm environments */ }
    }

    const lines = [
      '📋  Plan Mode — Ready for Review',
      '═'.repeat(55),
      '',
      title ? `**${title}**\n` : '',
      plan,
      '',
      '─'.repeat(55),
      '✅ Plan mode exited.',
      'Review the plan above. To execute, ask the AI to proceed.',
    ].filter((l) => l !== undefined);

    return lines.join('\n');
  },

  // A18 + E18: contextModifier restores prePlanApprovalMode on exit
  contextModifier(ctx) {
    const restoredMode = exitPlanMode() ?? ctx.approvalMode;
    return { ...ctx, planModeActive: false, approvalMode: restoredMode };
  },
};

/**
 * B27: _getPlanFilePath — returns .uagent/plan.md path relative to cwd.
 * Mirrors claude-code ExitPlanModeV2Tool getPlanFilePath().
 */
function _getPlanFilePath(): string {
  const { join: pjoin, resolve: presolve } = require('path') as typeof import('path');
  return presolve(process.cwd(), '.uagent', 'plan.md');
}
