/**
 * ask-user-question-tool.ts -- AskUserQuestion interactive tool
 *
 * Mirrors claude-code's AskUserQuestionTool.tsx.
 *
 * Allows the LLM to proactively ask the user a structured question with
 * predefined options, blocking the agent loop until the user responds.
 *
 * Design:
 * - Input schema: { questions: [{question, options: [{label, description}], multiSelect?}] }
 * - The tool writes a sentinel message to history and waits for user input
 * - User input is captured via readline/stdin in the agent loop
 * - For non-interactive sessions (CI), returns a timeout error
 *
 * Round 5: claude-code AskUserQuestionTool.tsx parity
 */

import type { ToolRegistration } from '../../../models/types.js';

// ── Input / Output Schema ─────────────────────────────────────────────────────

export interface AskUserOption {
  label: string;
  description: string;
  /** Optional preview (markdown/code) shown alongside the option */
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  /** Short chip/header label (≤20 chars) for display */
  header?: string;
  options: AskUserOption[];  // 2-4 options
  multiSelect?: boolean;
}

export interface AskUserInput {
  questions: AskUserQuestion[];  // 1-4 questions
  /** Pre-filled answers (used when re-submitting with answers) */
  answers?: Record<string, string>;
}

// ── Sentinel prefix injected into output (parsed by REPL) ─────────────────────

const ASK_USER_SENTINEL = '__ASK_USER__:';

// ── Tool definition ──────────────────────────────────────────────────────────

export const askUserQuestionTool: ToolRegistration = {
  definition: {
    name: 'AskUserQuestion',
    description: [
      'Ask the user one or more structured questions with predefined options.',
      'Use this tool when you need clarification before proceeding with an irreversible action,',
      'or when the user must choose between fundamentally different approaches.',
      '',
      'Rules:',
      '- Provide 2-4 options per question (not open-ended free text)',
      '- Use clear, concise option labels (1-5 words)',
      '- Include a helpful description for each option',
      '- Ask at most 4 questions per invocation',
      '- Do NOT use this for trivial decisions; prefer reasonable defaults',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          description: 'List of questions to ask (1-4)',
          items: {
            type: 'object',
            required: ['question', 'options'],
            properties: {
              question: {
                type: 'string',
                description: 'The complete question text. Should end with a question mark.',
              },
              header: {
                type: 'string',
                description: 'Short chip/label for the question (max 20 chars)',
              },
              options: {
                type: 'array',
                description: 'Available answer options (2-4 items)',
                items: {
                  type: 'object',
                  required: ['label', 'description'],
                  properties: {
                    label: { type: 'string', description: 'Option label (1-5 words)' },
                    description: { type: 'string', description: 'Explanation of this option (5-15 words)' },
                    preview: { type: 'string', description: 'Optional code/markdown preview' },
                  },
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'If true, user can select multiple options',
              },
            },
          },
        },
        answers: {
          type: 'object',
          description: 'Pre-filled answers (key=question text, value=selected label)',
        },
      },
      required: ['questions'],
    },
  },

  async handler(args: unknown): Promise<string> {
    const input = args as AskUserInput;

    // Validate
    if (!input.questions || !Array.isArray(input.questions) || input.questions.length === 0) {
      return '[AskUserQuestion] Error: questions array is required';
    }
    if (input.questions.length > 4) {
      return '[AskUserQuestion] Error: maximum 4 questions per invocation';
    }
    for (const q of input.questions) {
      if (!q.options || q.options.length < 2) {
        return `[AskUserQuestion] Error: question "${q.question}" must have at least 2 options`;
      }
      if (q.options.length > 4) {
        return `[AskUserQuestion] Error: question "${q.question}" may have at most 4 options`;
      }
    }

    // If answers are already provided (re-submission path), return them directly
    if (input.answers && Object.keys(input.answers).length > 0) {
      const answerLines = input.questions.map((q) => {
        const answer = input.answers![q.question] ?? input.answers![q.header ?? ''] ?? '(no answer)';
        return `  Q: ${q.question}\n  A: ${answer}`;
      });
      return `User answers:\n${answerLines.join('\n\n')}`;
    }

    // Interactive path: prompt user via stdin
    // Format questions as a numbered menu for readline REPL
    const lines: string[] = [
      '',
      '┌─ AskUserQuestion ─────────────────────────────────────────────',
    ];

    for (let qi = 0; qi < input.questions.length; qi++) {
      const q = input.questions[qi]!;
      lines.push(`│`);
      lines.push(`│  ${qi + 1}. ${q.question}`);
      q.options.forEach((opt, oi) => {
        lines.push(`│     [${oi + 1}] ${opt.label} — ${opt.description}`);
        if (opt.preview) {
          const previewLines = opt.preview.split('\n').slice(0, 3);
          previewLines.forEach((pl) => lines.push(`│         ${pl}`));
        }
      });
      if (q.multiSelect) {
        lines.push(`│     (multiple selections allowed, e.g. "1,3")`);
      }
    }
    lines.push(`│`);
    lines.push(`└───────────────────────────────────────────────────────────────`);

    // Emit sentinel so REPL knows to pause agent loop and collect user input
    // Format: __ASK_USER__:<JSON>
    const sentinel = ASK_USER_SENTINEL + JSON.stringify({
      questions: input.questions,
    });

    // In non-interactive mode (CI), immediately return "no answer" with instructions
    if (!process.stdout.isTTY) {
      return [
        '[AskUserQuestion] Non-interactive session detected.',
        'Questions:',
        ...input.questions.map((q, i) =>
          `  ${i + 1}. ${q.question}\n     Options: ${q.options.map((o) => o.label).join(' | ')}`
        ),
        '',
        'Please provide answers and re-invoke with the "answers" field set.',
      ].join('\n');
    }

    // Interactive: wait for user to type their answer
    const answers = await collectUserAnswers(input.questions);

    // Format result
    const resultLines = ['User answers:'];
    for (let qi = 0; qi < input.questions.length; qi++) {
      const q = input.questions[qi]!;
      const ans = answers[q.question] ?? '(no answer)';
      resultLines.push(`  Q: ${q.question}`);
      resultLines.push(`  A: ${ans}`);
    }

    // Suppress the sentinel line from stdout (it's internal)
    void sentinel;

    return resultLines.join('\n');
  },
};

// ── User input collection ─────────────────────────────────────────────────────

/**
 * Print questions to stdout and collect answers via readline.
 * Blocks until the user has answered all questions.
 */
async function collectUserAnswers(
  questions: AskUserQuestion[],
): Promise<Record<string, string>> {
  const { createInterface } = await import('readline');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const answers: Record<string, string> = {};

  // Print formatted questions
  console.log('\n' + '─'.repeat(65));
  console.log('  The AI needs your input:');
  console.log('─'.repeat(65));

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    console.log(`\n  ${qi + 1}. ${q.question}`);
    q.options.forEach((opt, oi) => {
      console.log(`     [${oi + 1}] ${opt.label} — ${opt.description}`);
    });
    if (q.multiSelect) {
      console.log('     (enter numbers separated by commas for multiple selections)');
    }

    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n  Your choice: `, (line) => {
        resolve(line.trim());
      });
    });

    // Map numeric answer to option label
    const trimmed = answer.trim();
    if (q.multiSelect && trimmed.includes(',')) {
      // Multi-select: map each number to its label
      const selectedLabels = trimmed.split(',').map((part) => {
        const idx = parseInt(part.trim(), 10) - 1;
        return q.options[idx]?.label ?? part.trim();
      });
      answers[q.question] = selectedLabels.join(', ');
    } else {
      const idx = parseInt(trimmed, 10) - 1;
      answers[q.question] = q.options[idx]?.label ?? trimmed;
    }
  }

  console.log('─'.repeat(65) + '\n');
  rl.close();

  return answers;
}
