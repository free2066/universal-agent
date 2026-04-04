/**
 * v0.4.0 — Ctrl+V / Ctrl+R logic tests
 *
 * Since keypress handlers are wired to process.stdin (not easily unit-testable),
 * we test the LOGIC that these handlers implement:
 *  - Clipboard image paste helpers (_pasteImage pattern)
 *  - Reverse-search cycle logic (_historySearchIdx cycling)
 *  - Custom command (.uagent/commands/*.md) loading and template substitution
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

// ── Helper: mimics the _pasteImage logic from repl.ts ──────────────────────
/**
 * Replicates the exact logic used in Ctrl+V handler:
 * execSync(cmd) → check existsSync(tmpPath) → read base64 → return true/false
 */
function pasteImageLogic(
  existsFn: (p: string) => boolean,
  readFn: (p: string) => Buffer,
  unlinkFn: (p: string) => void,
  tmpPath: string,
): { handled: boolean; base64: string; mimeType: string } | { handled: false } {
  try {
    if (existsFn(tmpPath)) {
      const base64 = readFn(tmpPath).toString('base64');
      try { unlinkFn(tmpPath); } catch { /* */ }
      return { handled: true, base64, mimeType: 'image/png' };
    }
  } catch { /* */ }
  return { handled: false };
}

// ── Helper: mimics Ctrl+R cycling logic ────────────────────────────────────
/**
 * Replicates the cycling logic in the Ctrl+R handler.
 * Given a history array and current search state, returns the next match index.
 */
function cycleReverseSearch(
  inputHistory: string[],
  query: string,
  currentIdx: number,
): { found: boolean; idx: number; match?: string } {
  const reversed = inputHistory.slice().reverse();
  const startFrom = currentIdx + 1;
  const nextIdx = reversed.slice(startFrom).findIndex((h) => h.includes(query));
  if (nextIdx !== -1) {
    const absoluteIdx = startFrom + nextIdx;
    return { found: true, idx: absoluteIdx, match: reversed[absoluteIdx] };
  }
  return { found: false, idx: currentIdx };
}

// ── Helper: mimics the first Ctrl+R trigger (find first match) ─────────────
function findFirstMatch(
  inputHistory: string[],
  query: string,
): { found: boolean; idx: number; match?: string } {
  const reversed = inputHistory.slice().reverse();
  const idx = reversed.findIndex((h) => h.includes(query));
  if (idx !== -1) {
    return { found: true, idx, match: reversed[idx] };
  }
  return { found: false, idx: -1 };
}

// ── Helper: mimics .uagent/commands/*.md template substitution ─────────────
function processCustomCommand(template: string, args: string): string {
  // Strip YAML frontmatter
  let body = template;
  if (body.startsWith('---\n')) {
    const endFm = body.indexOf('\n---\n', 4);
    if (endFm !== -1) body = body.slice(endFm + 5);
  }
  // Replace $ARGUMENTS and $1 $2 ...
  const argParts = args.split(/\s+/);
  body = body.replace(/\$ARGUMENTS/g, args);
  argParts.forEach((arg, idx) => {
    body = body.replace(new RegExp(`\\$${idx + 1}`, 'g'), arg);
  });
  return body.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Ctrl+V — paste image logic', () => {
  it('returns handled=false when file does not exist after execSync', () => {
    const result = pasteImageLogic(
      () => false,                      // existsFn → file not found
      () => Buffer.alloc(0),
      () => { /* */ },
      '/tmp/nonexistent.png',
    );
    expect(result.handled).toBe(false);
  });

  it('returns base64 and handled=true when file exists', () => {
    const fakeData = Buffer.from('PNG_FAKE_DATA_12345');
    const result = pasteImageLogic(
      () => true,                       // existsFn → file exists
      () => fakeData,
      () => { /* */ },
      '/tmp/fake-clipboard.png',
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.base64).toBe(fakeData.toString('base64'));
      expect(result.mimeType).toBe('image/png');
    }
  });

  it('calls unlink after reading the file', () => {
    const fakeData = Buffer.from('data');
    const unlinkCalled: string[] = [];
    pasteImageLogic(
      () => true,
      () => fakeData,
      (p) => { unlinkCalled.push(p); },
      '/tmp/test-clipboard.png',
    );
    expect(unlinkCalled).toContain('/tmp/test-clipboard.png');
  });

  it('handles unlink failure gracefully (no throw)', () => {
    const fakeData = Buffer.from('data');
    expect(() => pasteImageLogic(
      () => true,
      () => fakeData,
      () => { throw new Error('EPERM: unlink failed'); },
      '/tmp/test.png',
    )).not.toThrow();
  });

  it('handles read failure gracefully (no throw)', () => {
    expect(() => pasteImageLogic(
      () => true,
      () => { throw new Error('EACCES: permission denied'); },
      () => { /* */ },
      '/tmp/test.png',
    )).not.toThrow();
  });

  it('base64 encodes correctly for real small PNG', () => {
    // 1x1 red pixel PNG (minimal valid PNG bytes)
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const result = pasteImageLogic(
      () => true,
      () => pngBytes,
      () => { /* */ },
      '/tmp/pixel.png',
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.base64).toBe(pngBytes.toString('base64'));
      // base64 should not contain data: URI prefix
      expect(result.base64).not.toMatch(/^data:/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('Ctrl+R — reverse-search cycling logic', () => {
  const history = ['git push', 'npm run build', 'git commit -m "fix"', 'ls -la', 'git status'];

  it('findFirstMatch finds the most recent matching entry', () => {
    const result = findFirstMatch(history, 'git');
    expect(result.found).toBe(true);
    // Reversed: ['git status', 'ls -la', 'git commit...', 'npm run build', 'git push']
    // First match for 'git' = 'git status' (idx 0 in reversed)
    expect(result.match).toBe('git status');
    expect(result.idx).toBe(0);
  });

  it('findFirstMatch returns not found for no match', () => {
    const result = findFirstMatch(history, 'docker');
    expect(result.found).toBe(false);
    expect(result.idx).toBe(-1);
  });

  it('cycleReverseSearch cycles to next older match', () => {
    // Start at idx=0 ('git status'), cycle to next 'git' match
    const result = cycleReverseSearch(history, 'git', 0);
    expect(result.found).toBe(true);
    expect(result.match).toBe('git commit -m "fix"'); // idx 2 in reversed
  });

  it('cycleReverseSearch cycles again to find oldest match', () => {
    // Start at idx=2 ('git commit...'), cycle again for 'git'
    const result = cycleReverseSearch(history, 'git', 2);
    expect(result.found).toBe(true);
    expect(result.match).toBe('git push'); // oldest 'git' entry
  });

  it('cycleReverseSearch returns found=false when no more matches', () => {
    // Start at idx=4 (last in reversed = 'git push'), no more 'git' entries
    const result = cycleReverseSearch(history, 'git', 4);
    expect(result.found).toBe(false);
  });

  it('search is case-sensitive', () => {
    const result = findFirstMatch(history, 'GIT');
    expect(result.found).toBe(false);
  });

  it('search works on partial match', () => {
    const result = findFirstMatch(history, 'push');
    expect(result.found).toBe(true);
    expect(result.match).toBe('git push');
  });

  it('empty history returns no match', () => {
    const result = findFirstMatch([], 'anything');
    expect(result.found).toBe(false);
  });

  it('empty query matches everything', () => {
    // empty string is included in every string
    const result = findFirstMatch(history, '');
    expect(result.found).toBe(true);
    // Most recent entry should be first in reversed
    expect(result.match).toBe('git status');
  });

  it('cycling through all matches exhausts correctly', () => {
    let idx = -1;
    const matches: string[] = [];
    // Collect all 'git' matches
    for (let i = 0; i < 5; i++) {
      const r = cycleReverseSearch(history, 'git', idx);
      if (!r.found) break;
      matches.push(r.match!);
      idx = r.idx;
    }
    expect(matches).toEqual(['git status', 'git commit -m "fix"', 'git push']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('Custom commands — .uagent/commands/*.md template processing', () => {
  it('replaces $ARGUMENTS with the full argument string', () => {
    const template = 'Explain this concept: $ARGUMENTS';
    const result = processCustomCommand(template, 'machine learning');
    expect(result).toBe('Explain this concept: machine learning');
  });

  it('replaces $1 and $2 with positional arguments', () => {
    const template = 'Translate "$1" from $2 to English.';
    const result = processCustomCommand(template, 'bonjour French');
    expect(result).toBe('Translate "bonjour" from French to English.');
  });

  it('strips YAML frontmatter', () => {
    const template = `---
name: my-command
description: A custom command
---
Do something useful with: $ARGUMENTS`;
    const result = processCustomCommand(template, 'test input');
    expect(result).toBe('Do something useful with: test input');
    expect(result).not.toContain('name: my-command');
    expect(result).not.toContain('---');
  });

  it('strips frontmatter and replaces $1', () => {
    const template = `---
name: greet
---
Hello $1! Welcome to the project.`;
    const result = processCustomCommand(template, 'Alice');
    expect(result).toBe('Hello Alice! Welcome to the project.');
  });

  it('does not strip non-frontmatter leading dashes', () => {
    const template = '- Item one\n- Item two\n$ARGUMENTS';
    const result = processCustomCommand(template, 'extra');
    expect(result).toContain('- Item one');
    expect(result).toContain('extra');
  });

  it('handles empty arguments gracefully', () => {
    const template = 'Run this: $ARGUMENTS';
    const result = processCustomCommand(template, '');
    expect(result).toBe('Run this:');
  });

  it('handles template with no placeholders', () => {
    const template = 'Summarize the current conversation';
    const result = processCustomCommand(template, 'ignored args');
    expect(result).toBe('Summarize the current conversation');
  });

  it('replaces multiple occurrences of $ARGUMENTS', () => {
    const template = '$ARGUMENTS — please explain $ARGUMENTS in detail';
    const result = processCustomCommand(template, 'TypeScript generics');
    expect(result).toBe('TypeScript generics — please explain TypeScript generics in detail');
  });

  it('trims whitespace from output', () => {
    const template = '  \n  Hello world  \n  ';
    const result = processCustomCommand(template, '');
    expect(result).toBe('Hello world');
  });

  it('handles frontmatter with extra whitespace', () => {
    const template = `---
name: test
version: 1
---
Content here: $ARGUMENTS`;
    const result = processCustomCommand(template, 'foo bar');
    expect(result).toBe('Content here: foo bar');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('Custom commands — file-based loading (tmp directory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `uagent-test-cmds-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('can read and process a command file from disk', () => {
    const cmdPath = join(tmpDir, 'test-cmd.md');
    writeFileSync(cmdPath, `---
name: test-cmd
---
Tell me about: $ARGUMENTS`, 'utf-8');

    const raw = require('fs').readFileSync(cmdPath, 'utf-8');
    const result = processCustomCommand(raw, 'Node.js streams');
    expect(result).toBe('Tell me about: Node.js streams');
  });

  it('returns correct output for multi-arg command', () => {
    const cmdPath = join(tmpDir, 'translate.md');
    writeFileSync(cmdPath, 'Translate "$1" from $2 to $3.', 'utf-8');

    const raw = require('fs').readFileSync(cmdPath, 'utf-8');
    const result = processCustomCommand(raw, 'hello Spanish English');
    expect(result).toBe('Translate "hello" from Spanish to English.');
  });
});
