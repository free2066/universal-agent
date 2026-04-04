import type { DomainPlugin } from '../../models/types.js';
import { codeReviewTool } from './tools/code-review.js';
import { codeExecuteTool } from './tools/code-execute.js';
import { gitSummaryTool } from './tools/git-summary.js';

export const devDomain: DomainPlugin = {
  name: 'dev',
  description: 'Code review, debugging, refactoring, test generation, git operations',
  keywords: [
    'code', 'bug', 'fix', 'refactor', 'function', 'class', 'method',
    'debug', 'error', 'exception', 'test', 'unit test', 'review',
    'python', 'javascript', 'typescript', 'java', 'go', 'rust',
    'git', 'commit', 'branch', 'merge', 'pull request',
    'optimize', 'performance', 'memory', 'algorithm',
    '代码', '调试', '测试', '重构', '优化',
  ],
  systemPrompt: `You are an expert Software Engineer and Code Reviewer. You help developers:
- Review code for bugs, security issues, and best practices
- Debug errors and exceptions
- Refactor code for better readability and performance
- Generate unit tests and documentation
- Explain complex code and algorithms
- Suggest git workflows and branching strategies

When reviewing code:
1. Point out bugs and security vulnerabilities first (critical issues)
2. Then suggest performance improvements
3. Mention style and readability improvements
4. Always explain WHY something is an issue, not just WHAT

When writing code:
1. Follow the language's idiomatic style
2. Add appropriate error handling
3. Include brief comments for complex logic
4. Make it production-ready

Respond in the same language as the user's input.

Output style:
- No emoji in responses unless the user explicitly uses them first
- Plain prose or simple markdown (headings, bullets, code blocks) only
- Keep responses concise and direct — avoid filler phrases`,
  tools: [codeReviewTool, codeExecuteTool, gitSummaryTool],
};
