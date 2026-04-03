/**
 * GitHub PR Tool — Automatically create Pull Requests via GitHub API
 *
 * Inspired by kstack article #15380 "Hermes：AI 驱动的研发流程自动化实践"
 * (Hermes uses GitLab MR; we adapt for GitHub PR since the repo is on GitHub)
 *
 * Features:
 *   - Auto-detect repo info from git remote
 *   - Generate PR title/body from commit log + spec artifacts
 *   - Push current branch if not yet pushed
 *   - List open PRs for the current branch
 *   - Merge PR (for auto-merge workflows)
 *
 * Authentication:
 *   GITHUB_TOKEN or GH_TOKEN env var (personal access token with repo scope)
 *   Token can also be embedded in git remote URL (for CI environments)
 *
 * Usage:
 *   GitHubCreatePR title="feat: user login" body="..." base="main"
 *   GitHubListPRs
 *   GitHubMergePR pr_number=42
 */

import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('github-pr');

// ── GitHub API Client ──────────────────────────────────────────────────────────

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
  draft: boolean;
  body: string | null;
  created_at: string;
  user: { login: string };
}

interface GitHubError {
  message: string;
  errors?: Array<{ message: string }>;
}

function getGitHubToken(): string | null {
  // Priority: GITHUB_TOKEN > GH_TOKEN > embedded in remote URL
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // Try to extract from remote URL
  try {
    const remote = execSync('git remote get-url origin', {
      stdio: 'pipe', timeout: 3000,
    }).toString().trim();
    // Pattern: https://<token>@github.com/...
    const match = remote.match(/https:\/\/[^:@]+:([^@]+)@github\.com/);
    if (match) return match[1];
    // Pattern: https://<token>@github.com/...  (token as username)
    const match2 = remote.match(/https:\/\/([^:@]+)@github\.com/);
    if (match2) return match2[1];
  } catch { /* ignore */ }

  return null;
}

function getRepoInfo(): { owner: string; repo: string; apiBase: string } | null {
  try {
    const remote = execSync('git remote get-url origin', {
      stdio: 'pipe', timeout: 3000,
    }).toString().trim();

    // HTTPS: https://github.com/owner/repo.git or https://token@github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
        apiBase: 'https://api.github.com',
      };
    }

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (sshMatch) {
      return {
        owner: sshMatch[1],
        repo: sshMatch[2],
        apiBase: 'https://api.github.com',
      };
    }

    return null;
  } catch {
    return null;
  }
}

function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: 'pipe', timeout: 3000,
    }).toString().trim();
  } catch {
    return 'main';
  }
}

function getDefaultBase(): string {
  try {
    // Try to get the default branch from remote
    const result = execSync(
      'git remote show origin 2>/dev/null | grep "HEAD branch" | sed "s/.*: //"',
      { stdio: 'pipe', timeout: 5000, shell: '/bin/sh' },
    ).toString().trim();
    return result || 'main';
  } catch {
    return 'main';
  }
}

async function githubApi(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = getGitHubToken();
  const repoInfo = getRepoInfo();

  if (!repoInfo) {
    throw new Error('Cannot detect GitHub repo from git remote. Is this a GitHub repo?');
  }

  const url = `${repoInfo.apiBase}${path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// ── PR Body Generation ─────────────────────────────────────────────────────────

/**
 * Generate a PR body from recent commits and optional spec content.
 */
function generatePRBody(
  requirement: string,
  specContent?: string,
  reviewContent?: string,
): string {
  // Get recent commits for context
  let commits = '';
  try {
    const base = getDefaultBase();
    commits = execSync(
      `git log --oneline HEAD ^origin/${base} 2>/dev/null | head -20`,
      { stdio: 'pipe', timeout: 5000, shell: '/bin/sh' },
    ).toString().trim();
  } catch {
    try {
      commits = execSync('git log --oneline -10', {
        stdio: 'pipe', timeout: 3000,
      }).toString().trim();
    } catch { /* ignore */ }
  }

  let body = '';

  if (requirement) {
    body += `## 需求\n${requirement}\n\n`;
  }

  if (specContent) {
    // Extract summary from spec
    const specLines = specContent.split('\n').slice(0, 20).join('\n');
    body += `## 功能说明\n${specLines}\n\n`;
  }

  if (commits) {
    body += `## 变更记录\n\`\`\`\n${commits}\n\`\`\`\n\n`;
  }

  if (reviewContent) {
    // Extract P1/P2 issues from review
    const p1Lines = reviewContent.split('\n').filter((l) => l.includes('P1') || l.includes('P2'));
    if (p1Lines.length > 0) {
      body += `## Review 注意事项\n${p1Lines.slice(0, 5).join('\n')}\n\n`;
    }
  }

  body += `## 测试方法\n<!-- 请在此描述如何验证本次改动 -->\n\n`;
  body += `## Checklist\n- [ ] 功能验证完毕\n- [ ] 代码自审完毕\n- [ ] 测试用例已添加\n`;

  return body;
}

// ── Push Branch ────────────────────────────────────────────────────────────────

function ensureBranchPushed(branch: string): { pushed: boolean; output: string } {
  try {
    // Check if remote branch exists
    const remoteExists = execSync(
      `git ls-remote --heads origin ${branch}`,
      { stdio: 'pipe', timeout: 5000 },
    ).toString().trim();

    if (!remoteExists) {
      // Push the branch
      const output = execSync(`git push -u origin ${branch}`, {
        stdio: 'pipe', timeout: 30000,
      }).toString();
      return { pushed: true, output: `Pushed branch ${branch} to origin` };
    }
    return { pushed: false, output: `Branch ${branch} already exists on remote` };
  } catch (err) {
    return {
      pushed: false,
      output: `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Tool: GitHubCreatePR ───────────────────────────────────────────────────────

export const githubCreatePRTool: ToolRegistration = {
  definition: {
    name: 'GitHubCreatePR',
    description: `Create a GitHub Pull Request for the current branch.

Auto-detects: repo owner/name from git remote, current branch name, default base branch.
Generates PR body from commits, spec artifacts, and review notes if available.
Pushes the branch to remote if not yet pushed.

Requires: GITHUB_TOKEN or GH_TOKEN environment variable (personal access token with repo scope).
The token can also be embedded in the git remote URL: https://<token>@github.com/...

Examples:
  GitHubCreatePR title="feat: user login with SMS verification"
  GitHubCreatePR title="fix: auth token expiry" base="develop" draft=true
  GitHubCreatePR title="feat: xxx" body="Custom PR body..." labels="feature,needs-review"`,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'PR title. If omitted, will be generated from latest commit message.',
        },
        body: {
          type: 'string',
          description: 'PR body/description. If omitted, auto-generated from commits + spec artifacts.',
        },
        base: {
          type: 'string',
          description: 'Target branch for the PR. Defaults to the repo default branch (main/master).',
        },
        head: {
          type: 'string',
          description: 'Source branch. Defaults to current git branch.',
        },
        draft: {
          type: 'boolean',
          description: 'Create as draft PR. Default: false',
        },
        labels: {
          type: 'string',
          description: 'Comma-separated list of label names to apply.',
        },
        requirement: {
          type: 'string',
          description: 'Original requirement text (used for auto-generating PR body).',
        },
        autopilot_dir: {
          type: 'string',
          description: 'Path to autopilot spec directory (e.g. .uagent/autopilot/001) for including spec/review content in PR body.',
        },
      },
      required: [],
    },
  },

  handler: async (args) => {
    const token = getGitHubToken();
    if (!token) {
      return (
        '❌ No GitHub token found.\n' +
        'Set GITHUB_TOKEN or GH_TOKEN environment variable:\n' +
        '  export GITHUB_TOKEN=ghp_xxxx\n\n' +
        'Or embed in remote URL:\n' +
        '  git remote set-url origin https://ghp_xxxx@github.com/owner/repo.git'
      );
    }

    const repoInfo = getRepoInfo();
    if (!repoInfo) {
      return '❌ Cannot detect GitHub repo from git remote. Ensure origin points to github.com.';
    }

    const head = (args.head as string | undefined) ?? getCurrentBranch();
    const base = (args.base as string | undefined) ?? getDefaultBase();
    const draft = Boolean(args.draft ?? false);

    // Auto-generate title from last commit if not provided
    let title = args.title as string | undefined;
    if (!title) {
      try {
        title = execSync('git log -1 --pretty=%s', {
          stdio: 'pipe', timeout: 3000,
        }).toString().trim();
      } catch {
        title = `feat: changes from ${head}`;
      }
    }

    // Auto-generate body if not provided
    let body = args.body as string | undefined;
    if (!body) {
      const requirement = (args.requirement as string | undefined) ?? '';
      const autopilotDir = args.autopilot_dir as string | undefined;

      let specContent: string | undefined;
      let reviewContent: string | undefined;

      if (autopilotDir) {
        const { existsSync, readFileSync } = await import('fs');
        const { join } = await import('path');
        const specPath = join(autopilotDir, 'spec.md');
        const reviewPath = join(autopilotDir, 'review.md');
        if (existsSync(specPath)) specContent = readFileSync(specPath, 'utf-8');
        if (existsSync(reviewPath)) reviewContent = readFileSync(reviewPath, 'utf-8');
      }

      body = generatePRBody(requirement, specContent, reviewContent);
    }

    // Push branch if needed
    const pushResult = ensureBranchPushed(head);
    log.info(pushResult.output);

    // Create PR via API
    const prData: Record<string, unknown> = {
      title,
      body,
      head,
      base,
      draft,
    };

    const { ok, status, data } = await githubApi(
      'POST',
      `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
      prData,
    );

    if (!ok) {
      const err = data as GitHubError;
      // Handle "already exists" gracefully
      if (status === 422 && err.errors?.some((e) => e.message?.includes('already exists'))) {
        return (
          '⚠️  A PR already exists for this branch.\n' +
          `Use GitHubListPRs to find it or update it manually.\n` +
          `Branch: ${head} → ${base}`
        );
      }
      return `❌ GitHub API error ${status}: ${err.message ?? JSON.stringify(err)}`;
    }

    const pr = data as GitHubPR;

    // Apply labels if specified
    if (args.labels) {
      const labelList = (args.labels as string).split(',').map((l) => l.trim()).filter(Boolean);
      if (labelList.length > 0) {
        await githubApi('POST', `/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${pr.number}/labels`, {
          labels: labelList,
        }).catch(() => {/* labels may not exist */});
      }
    }

    return (
      `✅ PR created successfully!\n\n` +
      `📋 #${pr.number}: ${pr.title}\n` +
      `🔗 ${pr.html_url}\n` +
      `🌿 ${head} → ${base}\n` +
      `${draft ? '📝 Draft PR' : '🚀 Ready for review'}\n\n` +
      `${pushResult.pushed ? `📤 Branch pushed to remote: ${head}\n\n` : ''}` +
      `PR body preview:\n${body.slice(0, 500)}${body.length > 500 ? '\n...(truncated)' : ''}`
    );
  },
};

// ── Tool: GitHubListPRs ────────────────────────────────────────────────────────

export const githubListPRsTool: ToolRegistration = {
  definition: {
    name: 'GitHubListPRs',
    description: 'List open Pull Requests for the current repository, optionally filtered by branch.',
    parameters: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Filter by head branch name. Defaults to current branch.',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'PR state filter. Default: open',
        },
        limit: {
          type: 'number',
          description: 'Max PRs to return (default: 10, max: 30)',
        },
      },
      required: [],
    },
  },

  handler: async (args) => {
    const repoInfo = getRepoInfo();
    if (!repoInfo) {
      return '❌ Cannot detect GitHub repo from git remote.';
    }

    const state = (args.state as string | undefined) ?? 'open';
    const limit = Math.min((args.limit as number | undefined) ?? 10, 30);
    // Only filter by head branch if the user explicitly passed `branch`
    const branch = args.branch as string | undefined;

    const queryParams: Record<string, string> = {
      state,
      per_page: String(limit),
    };
    if (branch) {
      queryParams['head'] = `${repoInfo.owner}:${branch}`;
    }
    const params = new URLSearchParams(queryParams);

    const { ok, data } = await githubApi(
      'GET',
      `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls?${params}`,
    );

    if (!ok) {
      return `❌ GitHub API error: ${(data as GitHubError).message}`;
    }

    const prs = data as GitHubPR[];
    if (prs.length === 0) {
      const stateLabel = state === 'all' ? '' : ` ${state}`;
      const branchSuffix = branch ? ` for branch: ${branch}` : '';
      return `No${stateLabel} PRs found${branchSuffix}\nRepo: ${repoInfo.owner}/${repoInfo.repo}`;
    }

    const lines = prs.map((pr) =>
      `#${pr.number} [${pr.state}${pr.draft ? '/draft' : ''}] ${pr.title}\n` +
      `  ${pr.html_url}\n` +
      `  ${pr.head.ref} → ${pr.base.ref} | by ${pr.user.login} | ${pr.created_at.slice(0, 10)}`
    );

    return `Pull Requests (${repoInfo.owner}/${repoInfo.repo}):\n\n${lines.join('\n\n')}`;
  },
};

// ── Tool: GitHubMergePR ────────────────────────────────────────────────────────

export const githubMergePRTool: ToolRegistration = {
  definition: {
    name: 'GitHubMergePR',
    description: 'Merge a Pull Request by number. Requires GITHUB_TOKEN with repo write access.',
    parameters: {
      type: 'object',
      properties: {
        pr_number: {
          type: 'number',
          description: 'PR number to merge',
        },
        merge_method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Merge strategy. Default: squash',
        },
        commit_title: {
          type: 'string',
          description: 'Custom merge commit title (optional)',
        },
      },
      required: ['pr_number'],
    },
  },

  handler: async (args) => {
    const token = getGitHubToken();
    if (!token) {
      return '❌ No GitHub token found. Set GITHUB_TOKEN env var.';
    }

    const repoInfo = getRepoInfo();
    if (!repoInfo) {
      return '❌ Cannot detect GitHub repo from git remote.';
    }

    const prNumber = args.pr_number as number;
    const mergeMethod = (args.merge_method as string | undefined) ?? 'squash';
    const commitTitle = args.commit_title as string | undefined;

    const body: Record<string, unknown> = { merge_method: mergeMethod };
    if (commitTitle) body.commit_title = commitTitle;

    const { ok, status, data } = await githubApi(
      'PUT',
      `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}/merge`,
      body,
    );

    if (!ok) {
      const err = data as { message: string };
      return `❌ Merge failed (${status}): ${err.message}`;
    }

    const result = data as { sha: string; merged: boolean; message: string };
    return (
      `✅ PR #${prNumber} merged successfully!\n` +
      `  Method: ${mergeMethod}\n` +
      `  Commit: ${result.sha?.slice(0, 8) ?? '(unknown)'}\n` +
      `  Message: ${result.message}`
    );
  },
};
