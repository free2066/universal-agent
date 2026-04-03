/**
 * TestRunner — Inspired by kstack #15370 "TDD 驱动 AI 开发"
 *
 * Key insight from the article: AI can write tests and implementation in a loop,
 * but only if it can execute the tests itself and interpret the results.
 * The article describes: "AI 自主构造场景 → 调用方法 → 验证输出 → 形成可复用脚本"
 *
 * This tool detects the project test framework and runs tests with structured output:
 *   - Auto-detects: npm test, vitest, jest, pytest, cargo test, go test, mocha, etc.
 *   - Returns: passed/failed/skipped counts + failed test names + error snippets
 *   - Supports running a specific test file or test name pattern
 *   - Cleans up ANSI escape codes for clean LLM consumption
 *
 * Usage:
 *   TestRunner                       → auto-detect + run all tests
 *   TestRunner file="src/foo.test.ts"  → run specific file
 *   TestRunner pattern="MyClass"     → run tests matching a pattern
 *   TestRunner framework="pytest"    → force a specific framework
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Framework detection ───────────────────────────────────────────────────────

type Framework = 'vitest' | 'jest' | 'mocha' | 'npm-test' | 'pytest' | 'cargo' | 'go' | 'unknown';

interface FrameworkConfig {
  name: Framework;
  buildCmd: (file?: string, pattern?: string) => string;
  parseOutput: (raw: string) => TestResult;
}

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: string;
  failedTests: Array<{ name: string; error: string }>;
  summary: string;
  exitCode: number;
  rawOutput: string;
}

/** Strip ANSI escape codes for clean LLM output */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Truncate output to avoid flooding context */
function truncateOutput(s: string, maxChars = 6000): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return s.slice(0, half) + `\n\n... [${s.length - maxChars} chars omitted] ...\n\n` + s.slice(-half);
}

// ── Output parsers ────────────────────────────────────────────────────────────

function parseVitestOutput(raw: string): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  // Vitest: "Tests  5 passed | 2 failed (7)"  or  "✓ 5 | ✗ 2"
  const passMatch = raw.match(/(\d+)\s+passed/i);
  const failMatch = raw.match(/(\d+)\s+failed/i);
  const skipMatch = raw.match(/(\d+)\s+skipped/i);
  const durMatch  = raw.match(/Duration\s+([\d.]+\w+)/i);

  const passed  = passMatch  ? parseInt(passMatch[1])  : 0;
  const failed  = failMatch  ? parseInt(failMatch[1])  : 0;
  const skipped = skipMatch  ? parseInt(skipMatch[1])  : 0;

  // Extract failed test names and errors
  const failedTests: Array<{ name: string; error: string }> = [];
  const failBlocks = raw.matchAll(/×\s+(.+?)\n([\s\S]*?)(?=×|\n\n|$)/g);
  for (const m of failBlocks) {
    failedTests.push({
      name: m[1].trim(),
      error: m[2].trim().slice(0, 300),
    });
  }

  return {
    passed, failed, skipped,
    total: passed + failed + skipped,
    duration: durMatch?.[1],
    failedTests,
    summary: failed > 0
      ? `❌ ${failed} test(s) failed, ${passed} passed`
      : `✅ All ${passed} test(s) passed`,
  };
}

function parseJestOutput(raw: string): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  const passMatch  = raw.match(/(\d+)\s+pass(?:ed|ing)/i);
  const failMatch  = raw.match(/(\d+)\s+fail(?:ed|ing)/i);
  const skipMatch  = raw.match(/(\d+)\s+(?:skipped|pending|todo)/i);
  const durMatch   = raw.match(/Time:\s+([\d.]+\s*\w+)/i);

  const passed  = passMatch  ? parseInt(passMatch[1])  : 0;
  const failed  = failMatch  ? parseInt(failMatch[1])  : 0;
  const skipped = skipMatch  ? parseInt(skipMatch[1])  : 0;

  const failedTests: Array<{ name: string; error: string }> = [];
  const failLines = raw.matchAll(/●\s+(.+?)\n([\s\S]*?)(?=●|\n\nTest Suites:|$)/g);
  for (const m of failLines) {
    failedTests.push({ name: m[1].trim(), error: m[2].trim().slice(0, 300) });
  }

  return {
    passed, failed, skipped,
    total: passed + failed + skipped,
    duration: durMatch?.[1],
    failedTests,
    summary: failed > 0
      ? `❌ ${failed} test(s) failed, ${passed} passed`
      : `✅ All ${passed} test(s) passed`,
  };
}

function parsePytestOutput(raw: string): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  // pytest: "5 passed, 2 failed, 1 warning in 0.42s"
  const summaryMatch = raw.match(/(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*(\d+) (?:skipped|error))?.*?in ([\d.]+s)/i);
  const failOnlyMatch = raw.match(/(\d+) failed/i);

  const passed  = summaryMatch ? parseInt(summaryMatch[1]) : 0;
  const failed  = summaryMatch ? parseInt(summaryMatch[2] ?? '0') : (failOnlyMatch ? parseInt(failOnlyMatch[1]) : 0);
  const skipped = summaryMatch ? parseInt(summaryMatch[3] ?? '0') : 0;

  const failedTests: Array<{ name: string; error: string }> = [];
  const failLines = raw.matchAll(/FAILED\s+([\w/.::\-]+)/g);
  for (const m of failLines) {
    failedTests.push({ name: m[1], error: '' });
  }

  return {
    passed, failed, skipped,
    total: passed + failed + skipped,
    duration: summaryMatch?.[4],
    failedTests,
    summary: failed > 0
      ? `❌ ${failed} test(s) failed, ${passed} passed`
      : `✅ All ${passed} test(s) passed`,
  };
}

function parseCargoOutput(raw: string): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  // cargo test: "test result: FAILED. 3 passed; 2 failed; 0 ignored"
  const resultMatch = raw.match(/test result:\s*\w+\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/i);

  const passed  = resultMatch ? parseInt(resultMatch[1]) : 0;
  const failed  = resultMatch ? parseInt(resultMatch[2]) : 0;
  const skipped = resultMatch ? parseInt(resultMatch[3]) : 0;

  const failedTests: Array<{ name: string; error: string }> = [];
  const failLines = raw.matchAll(/FAILED\s+([\w:]+)/g);
  for (const m of failLines) failedTests.push({ name: m[1], error: '' });

  return {
    passed, failed, skipped, total: passed + failed + skipped,
    failedTests,
    summary: failed > 0
      ? `❌ ${failed} test(s) failed, ${passed} passed`
      : `✅ All ${passed} test(s) passed`,
  };
}

function parseGoOutput(raw: string): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  const passCount = (raw.match(/--- PASS:/g) ?? []).length;
  const failCount = (raw.match(/--- FAIL:/g) ?? []).length;
  const durMatch  = raw.match(/ok\s+[\w/]+\s+([\d.]+s)/i);

  const failedTests: Array<{ name: string; error: string }> = [];
  const failLines = raw.matchAll(/--- FAIL:\s+(\w+)/g);
  for (const m of failLines) failedTests.push({ name: m[1], error: '' });

  return {
    passed: passCount, failed: failCount, skipped: 0,
    total: passCount + failCount,
    duration: durMatch?.[1],
    failedTests,
    summary: failCount > 0
      ? `❌ ${failCount} test(s) failed, ${passCount} passed`
      : `✅ All ${passCount} test(s) passed`,
  };
}

function parseGenericOutput(raw: string, exitCode: number): Omit<TestResult, 'exitCode' | 'rawOutput'> {
  return {
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode !== 0 ? 1 : 0,
    skipped: 0, total: 1,
    failedTests: [],
    summary: exitCode === 0 ? '✅ Tests passed (exit code 0)' : `❌ Tests failed (exit code ${exitCode})`,
  };
}

// ── Framework auto-detection ──────────────────────────────────────────────────

function detectFramework(cwd: string): { framework: Framework; command: string } {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts ?? {};

      if (deps.vitest)       return { framework: 'vitest',   command: 'npx vitest run' };
      if (deps.jest)         return { framework: 'jest',     command: 'npx jest' };
      if (deps.mocha)        return { framework: 'mocha',    command: 'npx mocha' };
      if (scripts.test)      return { framework: 'npm-test', command: 'npm test' };
    } catch { /* ignore */ }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return { framework: 'cargo', command: 'cargo test' };
  if (existsSync(join(cwd, 'go.mod')))     return { framework: 'go',    command: 'go test ./...' };
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'setup.py')) || existsSync(join(cwd, 'pyproject.toml'))) {
    return { framework: 'pytest', command: 'python -m pytest' };
  }
  return { framework: 'unknown', command: 'npm test' };
}

function buildCommand(
  framework: Framework,
  baseCommand: string,
  file?: string,
  pattern?: string,
): string {
  let cmd = baseCommand;
  switch (framework) {
    case 'vitest':
      if (file)    cmd += ` "${file}"`;
      if (pattern) cmd += ` -t "${pattern}"`;
      cmd += ' --reporter=verbose 2>&1';
      break;
    case 'jest':
      if (file)    cmd += ` "${file}"`;
      if (pattern) cmd += ` -t "${pattern}"`;
      cmd += ' --no-coverage 2>&1';
      break;
    case 'pytest':
      if (file)    cmd += ` "${file}"`;
      if (pattern) cmd += ` -k "${pattern}"`;
      cmd += ' -v 2>&1';
      break;
    case 'cargo':
      if (pattern) cmd += ` "${pattern}"`;
      cmd += ' 2>&1';
      break;
    case 'go':
      if (pattern) cmd = `go test ./... -run "${pattern}" 2>&1`;
      else         cmd += ' -v 2>&1';
      break;
    default:
      cmd += ' 2>&1';
  }
  return cmd;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const testRunnerTool: ToolRegistration = {
  definition: {
    name: 'TestRunner',
    description: [
      'Run the project test suite and return structured results: pass/fail counts, failed test names, error snippets.',
      'Auto-detects the test framework from package.json / Cargo.toml / go.mod / pytest.ini.',
      'Supports: vitest, jest, mocha, npm test, pytest, cargo test, go test.',
      'Use this in a TDD loop: write tests → implement code → TestRunner → fix failures → repeat.',
      'Returns clean, ANSI-stripped output safe for LLM consumption.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Run only this test file. E.g. "src/foo.test.ts" or "tests/test_bar.py".',
        },
        pattern: {
          type: 'string',
          description: 'Run tests matching this name pattern (passed to -t / -k / --run depending on framework).',
        },
        framework: {
          type: 'string',
          enum: ['vitest', 'jest', 'mocha', 'npm-test', 'pytest', 'cargo', 'go'],
          description: 'Force a specific test framework (auto-detected if omitted).',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the test run. Defaults to current project directory.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default: 120, max: 600).',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();
    const file = args.file ? String(args.file) : undefined;
    const pattern = args.pattern ? String(args.pattern) : undefined;
    const timeoutSec = Math.min(Number(args.timeout_seconds ?? 120), 600);

    let { framework, command } = detectFramework(cwd);

    // Allow override
    if (args.framework) {
      framework = String(args.framework) as Framework;
      const frameMap: Record<string, string> = {
        vitest: 'npx vitest run', jest: 'npx jest', mocha: 'npx mocha',
        'npm-test': 'npm test', pytest: 'python -m pytest',
        cargo: 'cargo test', go: 'go test ./...',
      };
      command = frameMap[framework] ?? command;
    }

    const fullCommand = buildCommand(framework, command, file, pattern);

    let rawOutput = '';
    let exitCode = 0;
    const startTime = Date.now();

    try {
      rawOutput = execSync(fullCommand, {
        cwd,
        timeout: timeoutSec * 1000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      exitCode = e.status ?? 1;
      rawOutput = [e.stdout ?? '', e.stderr ?? ''].join('\n').trim();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const clean = stripAnsi(rawOutput);

    // Parse results based on framework
    let parsed: Omit<TestResult, 'exitCode' | 'rawOutput'>;
    switch (framework) {
      case 'vitest':    parsed = parseVitestOutput(clean); break;
      case 'jest':      parsed = parseJestOutput(clean); break;
      case 'pytest':    parsed = parsePytestOutput(clean); break;
      case 'cargo':     parsed = parseCargoOutput(clean); break;
      case 'go':        parsed = parseGoOutput(clean); break;
      default:          parsed = parseGenericOutput(clean, exitCode); break;
    }

    const result: TestResult = { ...parsed, exitCode, rawOutput: truncateOutput(clean) };

    // Build human-readable response
    const lines = [
      `🧪 TestRunner — ${framework} — ${elapsed}s — exit ${exitCode}`,
      `   CWD: ${cwd}`,
      `   Command: ${fullCommand.slice(0, 100)}`,
      ``,
      `📊 Results: ${result.summary}`,
      `   Passed:  ${result.passed}`,
      `   Failed:  ${result.failed}`,
      `   Skipped: ${result.skipped}`,
    ];
    if (result.duration) lines.push(`   Duration: ${result.duration}`);

    if (result.failedTests.length > 0) {
      lines.push(`\n❌ Failed Tests:`);
      for (const t of result.failedTests.slice(0, 10)) {
        lines.push(`  • ${t.name}`);
        if (t.error) lines.push(`    ${t.error.slice(0, 200).replace(/\n/g, '\n    ')}`);
      }
    }

    if (result.rawOutput && (result.failed > 0 || exitCode !== 0)) {
      lines.push(`\n📋 Output (relevant portion):`);
      lines.push(result.rawOutput.slice(0, 4000));
    }

    if (result.failed === 0 && exitCode === 0) {
      lines.push(`\n✅ All tests passed! No failures to fix.`);
    } else if (result.failed > 0) {
      lines.push(`\n💡 Next steps:`);
      lines.push(`   1. Fix the failed tests listed above`);
      lines.push(`   2. Run TestRunner again to verify`);
      lines.push(`   3. Use TestRunner pattern="<test name>" to run specific tests`);
    }

    return lines.join('\n');
  },
};
