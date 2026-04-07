/**
 * REPL main loop — extracted from src/cli/index.ts.
 * Delegates all /xxx slash commands to slash-handlers.ts.
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, relative, extname } from 'path';
import { spawnSync, execSync } from 'child_process';
import type { AgentCore } from '../../core/agent.js';
import { modelManager } from '../../models/model-manager.js';
import { subagentSystem } from '../../core/subagent-system.js';
import { initStatusBar, updateStatusBar, clearStatusBar, buildStatusPrompt, printStatusBar } from '../statusbar.js';
import { CliSpinner, summarizeArgs } from '../spinner.js';
import { HookRunner } from '../../core/hooks.js';
import { handleSlash, type SlashContext } from './slash-handlers.js';

// ── F1: @file fuzzy completion ────────────────────────────────────────────────
/** Recursively collect relative paths under `root` (depth-limited to 3). */
function collectFiles(root: string, dir: string, depth: number, results: string[]): void {
  if (depth > 3 || results.length > 500) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__']);
  for (const entry of entries) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        collectFiles(root, full, depth + 1, results);
      } else {
        results.push(relative(root, full));
      }
    } catch { /* permission denied etc. */ }
  }
}

function fuzzyFileComplete(query: string, cwd: string, max = 20): string[] {
  const all: string[] = [];
  collectFiles(cwd, cwd, 0, all);
  const q = query.toLowerCase();
  const hits = q
    ? all.filter(f => f.toLowerCase().includes(q))
    : all;
  // Prefer shorter paths and paths whose basename matches
  hits.sort((a, b) => {
    const aBase = a.toLowerCase().endsWith(q) ? 0 : 1;
    const bBase = b.toLowerCase().endsWith(q) ? 0 : 1;
    return aBase - bBase || a.length - b.length;
  });
  return hits.slice(0, max);
}

/** Resolve all @path references in user input, reading file contents. */
function resolveAtRefs(input: string, cwd: string): string {
  return input.replace(/@([^\s,;]+)/g, (_match, ref: string) => {
    // Skip @run-agent-xxx — those are subagent mentions, not file refs
    if (ref.startsWith('run-agent-') || ref.startsWith('ask-')) return _match;
    const fullPath = join(cwd, ref);
    if (!existsSync(fullPath)) return _match;
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lang = extname(ref).slice(1) || '';
      return `\n<file path="${ref}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</file>\n`;
    } catch { return _match; }
  });
}

export interface ReplOptions {
  domain: string;
  verbose?: boolean;
}

export interface ReplExtra {
  initialPrompt?: string;
  continueSession?: boolean;
  /** Resume a specific session by ID, title, or content keyword */
  resumeSessionId?: string;
  /** When resuming, fork to a new session ID instead of reusing the original (Round 4: claude-code --fork-session parity) */
  forkSession?: boolean;
  inferProviderEnvKey?: (msg: string) => string | undefined;
  /** notification config value — if set, trigger notification on session end */
  notification?: boolean | string;
}

export async function runREPL(
  agent: AgentCore,
  options: ReplOptions,
  extra: ReplExtra = {},
): Promise<void> {
  const hookRunner = new HookRunner(process.cwd());
  const { loadLastSnapshot, saveSnapshot, formatAge } = await import('../../core/memory/session-snapshot.js');
  const { SessionLogger } = await import('../session-logger.js');
  const { notification } = extra;

  // Unique session ID for this run
  const SESSION_ID = `session-${Date.now()}`;
  const SHORT_ID = Date.now().toString(16).slice(-8);

  // ── Status bar + prompt setup ──────────────────────────────────────────
  const { estimateHistoryTokens } = await import('../../core/context/context-compressor.js').catch(() => ({ estimateHistoryTokens: () => 0 }));
  const currentModel = modelManager.getCurrentModel('main');
  const { friendlyName } = await import('../model-picker.js');

  const _wqNameMap: Record<string, string> = {};
  (process.env.WQ_MODELS || '').split(',').forEach(entry => {
    const [id, ...nameParts] = entry.trim().split(':');
    if (nameParts.length > 0 && id) {
      _wqNameMap[id.trim()] = nameParts.join(':').trim();
    }
  });
  const getModelDisplayName = (modelId: string) => _wqNameMap[modelId] ?? friendlyName(modelId);

  const _startProfile = modelManager.listProfiles().find(p => p.name === currentModel);
  const _startContextLen = _startProfile?.contextLength ?? 128000;
  const _initialTokens = (() => {
    try {
      const h = agent.getHistory();
      return h.length > 0 && typeof estimateHistoryTokens === 'function'
        ? (estimateHistoryTokens as (h: unknown[]) => number)(h) : 0;
    } catch { return 0; }
  })();

  const makePrompt = (domain: string, model?: string) =>
    buildStatusPrompt(domain, model ?? getModelDisplayName(currentModel));

  const SLASH_COMPLETIONS = [
    '/help', '/clear', '/exit', '/resume', '/compact', '/tokens', '/cost',
    '/model', '/models', '/domain', '/continue',
    '/review', '/inspect', '/purify',
    '/spec', '/spec:brainstorm', '/spec:write-plan', '/spec:execute-plan',
    '/agents', '/team', '/tasks', '/inbox',
    '/image', '/history', '/hooks', '/insights', '/init', '/rules', '/memory',
    '/mcp',
    '/log', '/logs',
    // CF parity additions (v0.4.0)
    '/context', '/status', '/copy', '/export',
    '/branch', '/rename', '/add-dir',
    '/terminal-setup', '/bug', '/output-style',
    // CF parity additions (v0.4.1)
    '/skills', '/plugin', '/logout',
  ];

  function completer(line: string): [string[], string] {
    if (line.startsWith('/')) {
      const hits = SLASH_COMPLETIONS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : SLASH_COMPLETIONS, line];
    }
    if (line.startsWith('@')) {
      const query = line.slice(1);
      // File path completions
      const fileSuggestions = fuzzyFileComplete(query, process.cwd(), 15).map(f => `@${f}`);
      // Subagent completions
      const agentSuggestions = subagentSystem.listAgents().map((a) => `@run-agent-${a.name}`);
      const all = [...fileSuggestions, ...agentSuggestions].filter(s => s.startsWith(line));
      return [all.length ? all : fileSuggestions.length ? fileSuggestions : [], line];
    }
    return [[], line];
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: makePrompt(options.domain),
    completer,
  });

  // ── Shared keypress state ────────────────────────────────────────────────
  const _inputHistory: string[] = [];
  let _historySearch = false;
  let _historyQuery = '';

  // F4: Esc abort
  let _currentAbort: AbortController | null = null;

  // D31: agent 是否正在运行（用于 mid-turn 输入队列）
  // 当 _isAgentRunning=true 时，新输入入队而非丢弃
  let _isAgentRunning = false;

  // F6: Ctrl+L debug mode
  let _lastCtrlL = 0;

  // F7: Shift+Tab mode cycle
  const AGENT_MODES = ['default', 'plan', 'brainstorm', 'auto-edit'] as const;
  type AgentMode = typeof AGENT_MODES[number];
  let _modeIdx = 0;

  // F8: Esc×2 rollback
  let _lastEsc = 0;

  // Ctrl+R: reverse-search index (tracks position in cycle)
  let _historySearchIdx = -1;

  // F3: multiline input buffer
  const _pendingLines: string[] = [];
  let _multilineMode = false;

  const { emitKeypressEvents } = await import('readline');
  emitKeypressEvents(process.stdin);
  // IMPORTANT: must use setRawMode(true) so that Ctrl+T is delivered as a
  // keypress event instead of being intercepted by macOS as SIGINFO (which
  // prints "load: X.XX  cmd: node ..." lines to the terminal).
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // ── Ctrl+T: cycle thinking level ────────────────────────────────────────
  const THINKING_CYCLE: Array<import('../../models/types.js').ThinkingLevel | undefined> = [undefined, 'low', 'medium', 'high'];
  let _thinkingIdx = 0;

  process.stdin.on('keypress', (_ch: unknown, key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string } | undefined) => {
    if (!key) return;

    // ── Ctrl+T: cycle thinking level (status bar) ──────────────────────────
    if (key.ctrl && key.name === 't') {
      _thinkingIdx = (_thinkingIdx + 1) % THINKING_CYCLE.length;
      const level = THINKING_CYCLE[_thinkingIdx];
      try { agent.setThinkingLevel(level); } catch { /* not supported */ }
      updateStatusBar({ isThinking: (level ?? false) as import('../statusbar.js').ThinkingLevel });
      rl.prompt(); printStatusBar();
      return;
    }

    // ── Ctrl+R: toggle / cycle reverse history search ───────────────────────
    if (key.ctrl && key.name === 'r') {
      if (!_historySearch) {
        _historySearch = true;
        _historyQuery = '';
        _historySearchIdx = -1;
        process.stdout.write('\r\x1b[2K' + chalk.dim('(reverse-search) ') + chalk.cyan('_'));
      } else {
        // Already searching — cycle to next (older) match
        const _rv = _inputHistory.slice().reverse();
        const _from = _historySearchIdx + 1;
        const _ni = _rv.slice(_from).findIndex((h) => h.includes(_historyQuery));
        if (_ni !== -1) {
          _historySearchIdx = _from + _ni;
          process.stdout.write(`\r\x1b[2K${chalk.dim('(reverse-search)')} ${chalk.cyan(_historyQuery)}: ${chalk.white(_rv[_historySearchIdx]!)}`);
        } else {
          process.stdout.write(`\r\x1b[2K${chalk.dim('(reverse-search)')} ${chalk.cyan(_historyQuery)}: ${chalk.dim('no more matches')}`);
        }
      }
      return;
    }

    // ── F4: Esc — abort streaming OR start Esc×2 rollback ─────────────────
    if (key.name === 'escape' && !_historySearch) {
      if (_currentAbort) {
        // Single Esc while streaming → abort LLM output
        _currentAbort.abort();
        _currentAbort = null;
        process.stdout.write(chalk.yellow('\n  [aborted]\n'));
        rl.resume(); rl.prompt(); printStatusBar();
        _lastEsc = 0;
        return;
      }
      // F8: Esc×2 — rollback last exchange
      const now = Date.now();
      if (now - _lastEsc < 500) {
        const history = agent.getHistory();
        if (history.length >= 2) {
          const removed = history.splice(-2);
          agent.setHistory(history);
          const preview = String(
            (removed[0] as { content?: unknown })?.content ?? ''
          ).slice(0, 80).replace(/\n/g, ' ');
          process.stdout.write(chalk.yellow(`\n  ↩ Rolled back: "${preview}"\n`));
        } else {
          process.stdout.write(chalk.dim('\n  (nothing to roll back)\n'));
        }
        rl.prompt(); printStatusBar();
        _lastEsc = 0;
        return;
      }
      _lastEsc = now;
      return;
    }
    // Reset Esc timer on any other key
    if (key.name !== 'escape') _lastEsc = 0;

    // ── F5: Ctrl+G — open $EDITOR to edit current prompt ──────────────────
    if (key.ctrl && key.name === 'g') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vim';
      const tmpFile = `/tmp/uagent-edit-${Date.now()}.txt`;
      const curLine = (rl as unknown as { line: string }).line || '';
      writeFileSync(tmpFile, curLine, 'utf-8');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      clearStatusBar();
      spawnSync(editor, [tmpFile], { stdio: 'inherit' });
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      let newContent = '';
      try { newContent = readFileSync(tmpFile, 'utf-8').replace(/\n$/, ''); } catch { /* */ }
      try { unlinkSync(tmpFile); } catch { /* */ }
      // Re-init status bar after editor exit
      initStatusBar({
        model: getModelDisplayName(modelManager.getCurrentModel('main')),
        domain: options.domain,
        sessionId: SHORT_ID,
      });
      // Replace readline's current line buffer
      (rl as unknown as { line: string }).line = newContent;
      process.stdout.write('\r\x1b[2K' + makePrompt(options.domain) + newContent);
      rl.prompt(); printStatusBar();
      return;
    }

    // ── F6: Ctrl+L — clear screen (double = toggle debug mode) ────────────
    if (key.ctrl && key.name === 'l') {
      const now = Date.now();
      if (now - _lastCtrlL < 500) {
        options.verbose = !options.verbose;
        process.stdout.write(chalk.yellow(`\n  🔍 Debug mode: ${options.verbose ? 'ON' : 'OFF'}\n`));
      } else {
        process.stdout.write('\x1b[2J\x1b[H');
      }
      _lastCtrlL = now;
      rl.prompt(); printStatusBar();
      return;
    }

    // ── F7: Shift+Tab — cycle agent mode ──────────────────────────────────
    // Shift+Tab ANSI sequence is \x1b[Z in raw mode
    if (key.sequence === '\x1b[Z' || (key.shift && key.name === 'tab')) {
      _modeIdx = (_modeIdx + 1) % AGENT_MODES.length;
      const mode: AgentMode = AGENT_MODES[_modeIdx];
      const modePrompts: Record<AgentMode, string> = {
        'default': '',
        'plan': 'You are in PLAN mode. Think step by step and produce a detailed plan before taking any action. Do NOT edit files directly — output a plan first.',
        'brainstorm': 'You are in BRAINSTORM mode. Generate creative ideas and explore multiple approaches freely, without committing to edits or actions.',
        'auto-edit': 'You are in AUTO-EDIT mode. Apply code edits directly and immediately without asking for confirmation.',
      };
      try { agent.setSystemPrompt(modePrompts[mode]); } catch { /* */ }
      process.stdout.write(chalk.cyan(`\n  ⚙ Mode: ${mode}\n`));
      rl.prompt(); printStatusBar();
      return;
    }

    // ── Ctrl+V: paste image from clipboard (uses top-level execSync) ──────
    if (key.ctrl && key.name === 'v') {
      const _tryPasteImgV = (cmd: string, tmpPath: string): boolean => {
        try {
          execSync(cmd, { stdio: 'pipe' });
          if (existsSync(tmpPath)) {
            const base64 = readFileSync(tmpPath).toString('base64');
            try { unlinkSync(tmpPath); } catch { /* */ }
            const agentImgV = agent as AgentCore & { _pendingImage?: { data: string; mimeType: string } };
            agentImgV._pendingImage = { data: base64, mimeType: 'image/png' };
            rl.setPrompt(chalk.magenta('[image] ') + chalk.green('❯ '));
            process.stdout.write('\r\x1b[2K' + chalk.green('  ✓ Image from clipboard attached. Now type your question.') + '\n');
            rl.prompt(); printStatusBar();
            return true;
          }
        } catch { /* */ }
        return false;
      };
      const _tmpV = join('/tmp', `uagent-clipboard-${Date.now()}.png`);
      let _handledV = false;
      try {
        execSync('which pngpaste 2>/dev/null', { stdio: 'pipe' });
        _handledV = _tryPasteImgV(`pngpaste "${_tmpV}"`, _tmpV);
        if (!_handledV) { process.stdout.write('\r\x1b[2K' + chalk.yellow('  ⚠ No image in clipboard.') + '\n'); rl.prompt(); printStatusBar(); }
      } catch {
        const _tmpVL = join('/tmp', `uagent-clip-${Date.now()}.png`);
        try { execSync('which xclip 2>/dev/null', { stdio: 'pipe' }); _handledV = _tryPasteImgV(`xclip -selection clipboard -t image/png -o > "${_tmpVL}"`, _tmpVL); } catch { /* */ }
        if (!_handledV) { process.stdout.write('\r\x1b[2K' + chalk.dim('  (install pngpaste: brew install pngpaste)') + '\n'); rl.prompt(); printStatusBar(); }
      }
      return;
    }

    // ── Reverse-search input handling (when in search mode) ──────────────────
    if (!_historySearch) return;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      _historySearch = false;
      _historyQuery = '';
      _historySearchIdx = -1;
      rl.prompt(); printStatusBar();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      _historySearch = false;
      const _rv2 = _inputHistory.slice().reverse();
      const _mSel = _historySearchIdx >= 0 ? _rv2[_historySearchIdx] : _rv2.find((h) => h.includes(_historyQuery));
      _historyQuery = '';
      _historySearchIdx = -1;
      if (_mSel) {
        (rl as unknown as { line: string }).line = _mSel;
        process.stdout.write('\r\x1b[2K');
        rl.prompt(); printStatusBar();
        process.stdout.write(_mSel);
      } else {
        rl.prompt(); printStatusBar();
      }
      return;
    }
    if (key.name === 'backspace') {
      _historyQuery = _historyQuery.slice(0, -1);
      _historySearchIdx = -1;
    } else if (key.sequence && key.sequence.length === 1 && !key.ctrl) {
      _historyQuery += key.sequence;
      _historySearchIdx = -1;
    }
    const _rv3 = _inputHistory.slice().reverse();
    const _mDisp = _historySearchIdx >= 0 ? _rv3[_historySearchIdx] : _rv3.find((h) => h.includes(_historyQuery));
    process.stdout.write(`\r\x1b[2K${chalk.dim('(reverse-search)')} ${chalk.cyan(_historyQuery)}: ${_mDisp ? chalk.white(_mDisp) : chalk.dim('no match')}`);
  });

  // ── Welcome line ─────────────────────────────────────────────────────────
  const { loadSnapshot } = await import('../../core/memory/session-snapshot.js');
  const lastSnap = loadLastSnapshot();

  if (extra.resumeSessionId) {
    // -r / --resume <keyword|sessionId>: restore a specific session (claude-code parity)
    // Priority: exact sessionId → title match → content keyword search
    const { loadSnapshot, listAllSnapshots, searchSnapshots } = await import('../../core/memory/session-snapshot.js');
    let snap = loadSnapshot(extra.resumeSessionId);

    // Title match fallback
    if (!snap) {
      const allSnaps = listAllSnapshots(50);
      const keyword = extra.resumeSessionId.toLowerCase();
      const titleMatch = allSnaps.find((s) => s.displayTitle?.toLowerCase() === keyword)
        ?? allSnaps.find((s) => s.displayTitle?.toLowerCase().startsWith(keyword));
      if (titleMatch) snap = loadSnapshot(titleMatch.sessionId);
    }

    // Content keyword search fallback
    if (!snap) {
      const results = searchSnapshots(extra.resumeSessionId, 5);
      if (results.length > 0) {
        snap = loadSnapshot(results[0]!.sessionId);
        if (snap) {
          process.stdout.write(chalk.gray(`  (Matched keyword in session from ${formatAge(snap.savedAt)})\n`));
        }
      }
    }

    if (snap && snap.messages.length >= 2) {
      // --fork-session: create a new session ID for this resumed conversation
      if (extra.forkSession) {
        const { saveSnapshot: _saveSnap } = await import('../../core/memory/session-snapshot.js');
        const forkId = `fork-${Date.now()}`;
        _saveSnap(forkId, snap.messages);
        agent.setHistory(snap.messages);
        process.stdout.write(
          chalk.green(`  ✓ Forked session "${extra.resumeSessionId}" → "${forkId}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n',
        );
      } else {
        agent.setHistory(snap.messages);
        process.stdout.write(
          chalk.green(`  ✓ Resumed session "${extra.resumeSessionId}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n',
        );
      }
    } else {
      process.stdout.write(
        chalk.yellow(`  ⚠ Session "${extra.resumeSessionId}" not found — starting fresh`) + '\n',
      );
    }
  } else if (extra.continueSession && lastSnap && lastSnap.messages.length >= 2) {
    agent.setHistory(lastSnap.messages);
    process.stdout.write(
      chalk.green(`  ✓ Resumed session from ${formatAge(lastSnap.savedAt)} (${lastSnap.messages.length} messages)`) + '\n',
    );
  } else if (lastSnap && lastSnap.messages.length >= 2) {
    process.stdout.write(
      chalk.dim(`  Session from ${formatAge(lastSnap.savedAt)} available`) +
      chalk.dim(` · /resume to restore`) + '\n',
    );
  }
  process.stdout.write(
    chalk.dim('  Type ') + chalk.white('/help') +
    chalk.dim(' for commands · ') + chalk.white('@file') +
    chalk.dim(' to reference files · ') + chalk.white('Ctrl+C') +
    chalk.dim(' to exit') + '\n\n',
  );

  const customCmds = hookRunner.listSlashCommands();
  if (customCmds.length > 0) {
    process.stdout.write(chalk.dim(`  Custom: ${customCmds.map((c) => c.command).join('  ')}\n\n`));
  }

  if (extra.initialPrompt) {
    setTimeout(() => rl.emit('line', extra.initialPrompt!), 100);
  }

  // ── Session Logger ────────────────────────────────────────────────────────
  const sessionLogger = new SessionLogger({
    model: getModelDisplayName(currentModel),
    domain: options.domain,
    sessionId: SHORT_ID,
  });
  process.stdout.write(
    chalk.dim(`  📝 Session log: `) + chalk.gray(sessionLogger.path) + '\n',
  );

  initStatusBar({
    model: getModelDisplayName(currentModel),
    domain: options.domain,
    sessionId: SHORT_ID,
    estimatedTokens: _initialTokens,
    contextLength: _startContextLen,
    isThinking: 'none' as const,
  }, () => {
    rl.setPrompt(makePrompt(options.domain));
  });

  rl.prompt(); printStatusBar();

  // Build the slash context once — passed to handleSlash on every /xxx line
  const slashCtx: SlashContext = {
    agent,
    rl,
    hookRunner,
    sessionLogger,
    options,
    SESSION_ID,
    getModelDisplayName,
    makePrompt,
    loadLastSnapshot,
    saveSnapshot,
    formatAge,
    inferProviderEnvKey: extra.inferProviderEnvKey ?? (() => undefined),
  };

  rl.on('line', async (line) => {
    // ── F3: multiline input ───────────────────────────────────────────────
    // \ at end of line continues input; Ctrl+J also triggers continue
    if (line.endsWith('\\') || _multilineMode) {
      const seg = line.endsWith('\\') ? line.slice(0, -1) : line;
      _pendingLines.push(seg);
      if (line.endsWith('\\')) {
        // More lines expected
        _multilineMode = true;
        rl.setPrompt(chalk.dim('... '));
        rl.prompt();
        return;
      }
      // Last line of multiline (no trailing \)
      _multilineMode = false;
      rl.setPrompt(makePrompt(options.domain));
    }

    const rawInput = _pendingLines.length > 0
      ? (_pendingLines.splice(0).join('\n') + (line.length ? '\n' + line : '')).trim()
      : line.trim();

    const input = rawInput;
    if (!input) { rl.prompt(); printStatusBar(); return; }

    if (_historySearch) { _historySearch = false; _historyQuery = ''; }
    if (input && (_inputHistory.length === 0 || _inputHistory[_inputHistory.length - 1] !== input)) {
      _inputHistory.push(input);
      if (_inputHistory.length > 500) _inputHistory.shift();
    }

    sessionLogger.logInput(input);

    // B30: awaySummary — if user was away long enough, show a quick recap
    // Mirrors claude-code src/services/awaySummary.ts generateAwaySummary()
    try {
      const { shouldGenerateAwaySummary, generateAwaySummary, touchLastActivity } =
        await import('../../core/agent/away-summary.js');
      if (shouldGenerateAwaySummary() && agent.getHistory().length > 0) {
        const awayResult = await generateAwaySummary(
          agent.getHistory() as Array<{ role: string; content: string | unknown[] }>,
        );
        if (awayResult) {
          const mins = Math.round(awayResult.awayDurationMs / 60_000);
          const dur = mins < 1 ? 'just now' : `${mins}m ago`;
          process.stdout.write(chalk.dim(`\n◈ While you were away (${dur}): ${awayResult.summary}\n\n`));
        }
      }
      touchLastActivity(); // B30: reset idle timer on each user input
    } catch { /* B30: non-fatal */ }

    // D31: mid-turn input queue — if agent is already running, enqueue instead of processing
    // Mirrors claude-code messageQueueManager.ts commandQueue enqueueing during active turn
    if (_isAgentRunning) {
      const { inputQueue } = await import('../../core/utils/input-queue.js');
      inputQueue.enqueue(input);
      process.stdout.write(chalk.dim(`  ↳ queued (${inputQueue.length} pending, finish current response first)\n`));
      return;
    }

    // ── F2: !bash prefix — run shell command directly, inject output into context ──
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) { rl.prompt(); printStatusBar(); return; }
      rl.pause();
      process.stdout.write(chalk.dim(`\n  $ ${cmd}\n`));
      let shellOutput = '';
      try {
        const { execSync } = await import('child_process');
        shellOutput = execSync(cmd, {
          cwd: process.cwd(), encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
        });
        process.stdout.write(shellOutput);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        shellOutput = (err.stdout ?? '') + (err.stderr ? `\nstderr: ${err.stderr}` : '');
        if (err.stdout) process.stdout.write(err.stdout);
        if (err.stderr) process.stdout.write(chalk.red(err.stderr));
      }
      // Inject the command + output into agent context (no LLM call)
      agent.injectContext(`$ ${cmd}\n${shellOutput}`);
      process.stdout.write('\n');
      rl.resume(); rl.prompt(); printStatusBar();
      return;
    }

    // Delegate slash commands to slash-handlers
    if (input.startsWith('/') || input === '/help ' || input === '/exit' || input === '/quit') {
      const handled = await handleSlash(input, slashCtx);
      if (handled) return;
    }

    // ── LLM path ─────────────────────────────────────────────────────────────
    _isAgentRunning = true; // D31: mark agent as running — subsequent inputs go to queue
    rl.pause();
    process.stdout.write('\n');
    try {
      const hookCtx = await hookRunner.run({
        event: 'pre_prompt', prompt: input, cwd: process.cwd(),
      }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

      // ── F1: resolve @file references → embed file content ──────────────
      let finalInput = resolveAtRefs(input, process.cwd());
      if (!hookCtx.proceed) {
        console.log(chalk.yellow(`  [hook] Blocked: ${hookCtx.value ?? 'no reason given'}`));
        rl.resume();
        rl.prompt(); printStatusBar();
        return;
      }
      if (hookCtx.injection) {
        // Fix: use finalInput (already @file-expanded) not raw input
        // (App.tsx parity: ink/App.tsx uses resolvedInput here, not original input)
        finalInput = `${finalInput}\n\n---\n${hookCtx.injection}`;
      }

      const agentWithImage = agent as AgentCore & { _pendingImage?: { data: string; mimeType: string } };
      if (agentWithImage._pendingImage) {
        const { data, mimeType } = agentWithImage._pendingImage;
        delete agentWithImage._pendingImage;
        rl.setPrompt(makePrompt(options.domain));
        // Append the image as a multimodal ContentBlock to the prompt
        // agent.runStream will receive a string prompt; we attach image via injectContext
        // by constructing a multimodal message directly
        const imageBlock: import('../../models/types.js').ImageBlock = { type: 'image', data, mimeType };
        const multiContent: import('../../models/types.js').ContentBlock[] = [
          finalInput,
          imageBlock,
        ];
        // Override finalInput with a marker and attach image block via agent history injection
        agent.injectImagePrompt(finalInput, imageBlock);
        finalInput = ''; // consumed by injectImagePrompt
        console.log(chalk.gray('  (Image attached to this request)'));
      }

      const spinner = new CliSpinner();
      // tool-call sequence counter (for deduplicating concurrent same-name calls)
      let toolCallSeq = 0;
      // pending tool key → start timestamp (for duration calculation)
      const toolStartTimes = new Map<string, number>();
      // pending tool key → args summary (for ↳ line on completion)
      const toolArgMap = new Map<string, string>();

      updateStatusBar({ isThinking: 'low' });
      spinner.start('thinking');

      let firstChunk = true;
      let charCount = 0;
      let toolsPrinted = false;

      // F4: create AbortController for Esc to cancel streaming
      _currentAbort = new AbortController();

      await agent.runStream(
        finalInput,
        (chunk) => {
          if (firstChunk) {
            spinner.stop(false);
            // blank line to separate tool-calls block from response text
            if (toolsPrinted) process.stdout.write('\n');
            updateStatusBar({ isThinking: 'medium' });
            firstChunk = false;
          }
          process.stdout.write(chunk);
          charCount += chunk.length;
          sessionLogger.logChunk(chunk);
        },
        {
          onToolStart: (name, args) => {
            // First tool call: stop the "thinking" spinner
            if (!toolsPrinted) {
              spinner.stop(false);
              toolsPrinted = true;
            }

            const argStr = summarizeArgs(args);
            const seqKey = `${name}#${toolCallSeq++}`;
            toolStartTimes.set(seqKey, Date.now());
            toolArgMap.set(seqKey, argStr);

            // Style: cyan bold tool name + dim args in parens — like the reference UI
            const cols = process.stdout.columns ?? 120;
            const maxArgLen = Math.max(0, cols - name.length - 4);
            const truncated = argStr.length > maxArgLen;
            const argsDisplay = argStr.length > 0
              ? chalk.dim('(' + argStr.slice(0, maxArgLen) + (truncated ? '...' : '') + ')')
              : '';

            process.stdout.write(
              chalk.cyan.bold(name) + argsDisplay + '\n'
            );

            sessionLogger.logToolStart(name, args as Record<string, unknown>);
            updateStatusBar({ isThinking: 'medium' });
          },
          onToolEnd: (name, success, durationMs) => {
            // Find matching pending key (first match wins)
            let matchedKey: string | undefined;
            for (const k of toolStartTimes.keys()) {
              if (k.startsWith(`${name}#`)) { matchedKey = k; break; }
            }
            if (matchedKey) {
              toolStartTimes.delete(matchedKey);
              toolArgMap.delete(matchedKey);
            }

            const durationStr = durationMs < 1000
              ? `${durationMs}ms`
              : `${(durationMs / 1000).toFixed(1)}s`;

            // ↳ result line — dim gray, indented
            const resultLine = success
              ? chalk.dim(`↳ done (${durationStr}).`)
              : chalk.hex('#ef4444')(`↳ failed (${durationStr}).`);
            process.stdout.write(`${resultLine}\n`);

            sessionLogger.logToolEnd(name, success, durationMs);
          },
        },
        undefined,
        _currentAbort.signal,
      );
      _currentAbort = null;

      if (firstChunk) {
        spinner.stop(false);
        process.stdout.write('\n');
      } else {
        spinner.stop(false);
        if (charCount > 0) process.stdout.write('\n');
      }
      try {
        const h = agent.getHistory();
        const est = typeof estimateHistoryTokens === 'function' ? (estimateHistoryTokens as (h: unknown[]) => number)(h) : 0;
        updateStatusBar({ isThinking: 'none', estimatedTokens: est });
        rl.setPrompt(makePrompt(options.domain));
      } catch { updateStatusBar({ isThinking: 'none' }); rl.setPrompt(makePrompt(options.domain)); }
      sessionLogger.flushOutput();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError =
        msg.includes('401') || msg.includes('403') ||
        msg.includes('Unauthorized') || msg.includes('invalid_api_key') ||
        msg.includes('API_KEY') || msg.includes('api key') ||
        msg.includes('authentication') || msg.includes('No API key') ||
        msg.includes('api-key') || msg.includes('Authentication');
      if (isAuthError) {
        console.error(chalk.red('\n✗ API key missing or invalid.'));
        console.log(chalk.yellow('\n  Starting API key setup...\n'));
        sessionLogger.logError(err);
        try {
          const { configureAgent } = await import('../configure.js');
          const providerKey = extra.inferProviderEnvKey ? extra.inferProviderEnvKey(msg) : undefined;
          await configureAgent('API authentication failed — please add or update your key', providerKey);
          const { config: loadEnv } = await import('dotenv');
          const { resolve: r } = await import('path');
          loadEnv({ path: r(process.cwd(), '.env'), override: true });
          modelManager.clearClientCache();
          console.log(chalk.green('✓ Keys updated. Try your request again.\n'));
        } catch (cfgErr) {
          console.error(chalk.gray('  Config error: ' + (cfgErr instanceof Error ? cfgErr.message : String(cfgErr))));
        }
      } else {
        console.error(chalk.red('\n✗ ') + msg);
        sessionLogger.logError(err);
      }
    }
    _isAgentRunning = false; // D31: agent finished, allow new input
    rl.resume();
    rl.prompt(); printStatusBar();

    // D31: consume queued input after agent completes
    // Mirrors claude-code processQueuedCommands() after turn completion
    try {
      const { inputQueue } = await import('../../core/utils/input-queue.js');
      const nextInput = inputQueue.dequeue();
      if (nextInput) {
        const remaining = inputQueue.length;
        const hint = remaining > 0 ? ` (${remaining} more queued)` : '';
        process.stdout.write(chalk.dim(`\n  ↳ Auto-processing queued: "${nextInput.slice(0, 50)}"${hint}\n`));
        // Emit as new line event after a short delay for UI stability
        setTimeout(() => rl.emit('line', nextInput), 80);
      }
    } catch { /* D31: non-fatal */ }
  });

  rl.on('close', () => {
    sessionLogger.close();
    const history = agent.getHistory();
    if (history.length >= 2) {
      try { saveSnapshot(SESSION_ID, history); } catch (err) { process.stderr.write(`[repl] Failed to save session snapshot: ${String(err)}\n`); }
    }
    // Trigger notification on session end (if configured)
    const notifyValue = notification;
    if (notifyValue !== undefined && notifyValue !== false) {
      import('../notification.js').then(({ triggerNotification }) => {
        triggerNotification(notifyValue).catch(() => {/* non-fatal */});
      }).catch(() => {});
    }
    if (history.length >= 4) {
      (async () => {
        try {
          // Drain incremental ingest tasks (fired per-round in agent-loop.ts).
          // Inspired by claude-code's drainPendingExtraction pattern:
          // wait up to 5s for any in-flight extraction to finish before exit.
          const { drainIngest } = await import('../../core/memory/memory-store.js');
          await drainIngest(5000);
        } catch (err) { process.stderr.write(`[repl] Memory drain failed: ${String(err)}\n`); }
      })().finally(() => {
        clearStatusBar();
        console.log(chalk.dim('\nGoodbye!'));
        process.exit(0);
      });
    } else {
      clearStatusBar();
      console.log(chalk.dim('\nGoodbye!'));
      process.exit(0);
    }
  });
}
