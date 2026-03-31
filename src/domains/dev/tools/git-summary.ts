import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

export const gitSummaryTool: ToolRegistration = {
  definition: {
    name: 'git_summary',
    description: 'Get a summary of recent git commits, current branch, and changed files',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the git repository (default: current directory)' },
        limit: { type: 'number', description: 'Number of recent commits to show (default: 10)' },
      },
    },
  },
  handler: async (args) => {
    const repoPath = (args.path as string) || process.cwd();
    const limit = (args.limit as number) || 10;

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();

      const log = execSync(
        `git log --oneline --no-merges -${limit} --pretty=format:"%h %ad %s" --date=short`,
        { cwd: repoPath, encoding: 'utf-8' }
      ).trim();

      const status = execSync('git status --short', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();

      const diffStat = execSync('git diff --stat HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();

      return {
        branch,
        recent_commits: log.split('\n').slice(0, limit),
        working_tree: status || '(clean)',
        diff_summary: diffStat || '(no uncommitted changes)',
      };
    } catch (err) {
      return { error: `Not a git repository or git not installed: ${err}` };
    }
  },
};
