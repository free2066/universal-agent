/**
 * REPL main loop — extracted from src/cli/index.ts.
 * Delegates all /xxx slash commands to slash-handlers.ts.
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import type { AgentCore } from '../../core/agent.js';
import { modelManager } from '../../models/model-manager.js';
import { subagentSystem } from '../../core/subagent-system.js';
import { initStatusBar, updateStatusBar, clearStatusBar, buildStatusPrompt, printStatusBar } from '../statusbar.js';
import { CliSpinner, summarizeArgs } from '../spinner.js';
import { HookRunner } from '../../core/hooks.js';
import { handleSlash, type SlashContext } from './slash-handlers.js';

export interface ReplOptions {
  domain: string;
  verbose?: boolean;
}

export interface ReplExtra {
  initialPrompt?: string;
  continueSession?: boolean;
  /** Resume a specific session by ID — takes precedence over continueSession */
  resumeSessionId?: string;
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
    '/review', '/inspect', '/purify', '/spec',
    '/agents', '/team', '/tasks', '/inbox',
    '/image', '/history', '/hooks', '/insights', '/init', '/rules', '/memory',
    '/mcp',
    '/log', '/logs',
  ];

  function completer(line: string): [string[], string] {
    if (line.startsWith('/')) {
      const hits = SLASH_COMPLETIONS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : SLASH_COMPLETIONS, line];
    }
    if (line.startsWith('@')) {
      const agents = subagentSystem.listAgents().map((a) => `@run-agent-${a.name}`);
      const hits = agents.filter((a) => a.startsWith(line));
      return [hits.length ? hits : [], line];
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

  // ── Ctrl+R: reverse history search ──────────────────────────────────────
  const _inputHistory: string[] = [];
  let _historySearch = false;
  let _historyQuery = '';

  const { emitKeypressEvents } = await import('readline');
  emitKeypressEvents(process.stdin);
  // IMPORTANT: must use setRawMode(true) so that Ctrl+T is delivered as a
  // keypress event instead of being intercepted by macOS as SIGINFO (which
  // prints "load: X.XX  cmd: node ..." lines to the terminal).
  // We re-enable raw mode here; it is temporarily disabled before spawning
  // child processes (bash tool) and re-enabled afterwards.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // ── Ctrl+T: cycle thinking level ────────────────────────────────────────
  // Cycles: off → low → medium → high → off → ...
  // Aligns with CodeFlicker CLI's Ctrl+T toggle.
  const THINKING_CYCLE: Array<import('../../models/types.js').ThinkingLevel | undefined> = [undefined, 'low', 'medium', 'high'];
  let _thinkingIdx = 0;

  process.stdin.on('keypress', (_ch: unknown, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
    if (!key) return;
    if (key.ctrl && key.name === 't') {
      _thinkingIdx = (_thinkingIdx + 1) % THINKING_CYCLE.length;
      const level = THINKING_CYCLE[_thinkingIdx];
      const display = level ?? 'off';
      try { agent.setThinkingLevel(level); } catch { /* not supported */ }
      process.stdout.write(
        '\r\x1b[2K' + chalk.yellow(`  🧠 Thinking: ${display}`) + '\n',
      );
      rl.prompt(); printStatusBar();
      return;
    }
    if (key.ctrl && key.name === 'r') {
      _historySearch = true;
      _historyQuery = '';
      process.stdout.write('\r\x1b[2K' + chalk.dim('(reverse-search) ') + chalk.cyan('_'));
      return;
    }
    if (!_historySearch) return;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      _historySearch = false;
      _historyQuery = '';
      rl.prompt(); printStatusBar();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      _historySearch = false;
      const match = _inputHistory.slice().reverse().find((h) => h.includes(_historyQuery));
      _historyQuery = '';
      if (match) {
        (rl as unknown as { line: string }).line = match;
        process.stdout.write('\r\x1b[2K');
        rl.prompt(); printStatusBar();
        process.stdout.write(match);
      } else {
        rl.prompt(); printStatusBar();
      }
      return;
    }
    if (key.name === 'backspace') {
      _historyQuery = _historyQuery.slice(0, -1);
    } else if (key.sequence && key.sequence.length === 1 && !key.ctrl) {
      _historyQuery += key.sequence;
    }
    const match = _inputHistory.slice().reverse().find((h) => h.includes(_historyQuery));
    const display = match ? chalk.white(match) : chalk.dim('no match');
    process.stdout.write(`\r\x1b[2K${chalk.dim('(reverse-search)')} ${chalk.cyan(_historyQuery)}: ${display}`);
  });

  // ── Welcome line ─────────────────────────────────────────────────────────
  const { loadSnapshot } = await import('../../core/memory/session-snapshot.js');
  const lastSnap = loadLastSnapshot();

  if (extra.resumeSessionId) {
    // -r / --resume <sessionId>: restore a specific session by ID
    const snap = loadSnapshot(extra.resumeSessionId);
    if (snap && snap.messages.length >= 2) {
      agent.setHistory(snap.messages);
      process.stdout.write(
        chalk.green(`  ✓ Resumed session ${extra.resumeSessionId} from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n',
      );
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
    const input = line.trim();
    if (!input) { rl.prompt(); printStatusBar(); return; }

    if (_historySearch) { _historySearch = false; _historyQuery = ''; }
    if (input && (_inputHistory.length === 0 || _inputHistory[_inputHistory.length - 1] !== input)) {
      _inputHistory.push(input);
      if (_inputHistory.length > 500) _inputHistory.shift();
    }

    sessionLogger.logInput(input);

    // Delegate slash commands to slash-handlers
    if (input.startsWith('/') || input === '/help ' || input === '/exit' || input === '/quit') {
      const handled = await handleSlash(input, slashCtx);
      if (handled) return;
    }

    // ── LLM path ─────────────────────────────────────────────────────────────
    rl.pause();
    process.stdout.write('\n');
    try {
      const hookCtx = await hookRunner.run({
        event: 'pre_prompt', prompt: input, cwd: process.cwd(),
      }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

      let finalInput = input;
      if (!hookCtx.proceed) {
        console.log(chalk.yellow(`  [hook] Blocked: ${hookCtx.value ?? 'no reason given'}`));
        rl.resume();
        rl.prompt(); printStatusBar();
        return;
      }
      if (hookCtx.injection) {
        finalInput = `${input}\n\n---\n${hookCtx.injection}`;
      }

      const agentWithImage = agent as AgentCore & { _pendingImage?: string };
      if (agentWithImage._pendingImage) {
        const imgDataUrl = agentWithImage._pendingImage;
        delete agentWithImage._pendingImage;
        rl.setPrompt(makePrompt(options.domain));
        finalInput = `[Image attached — analyze this image]\n${finalInput}\n\n[Image data: ${imgDataUrl.slice(0, 100)}...]`;
        console.log(chalk.gray('  (Image context attached to this request)'));
      }

      const spinner = new CliSpinner();
      let toolCallSeq = 0;
      const toolIndexMap = new Map<string, number>();
      const pendingToolKeys: string[] = [];

      updateStatusBar({ isThinking: 'low' });
      spinner.start('thinking');

      let firstChunk = true;
      let charCount = 0;

      await agent.runStream(
        finalInput,
        (chunk) => {
          if (firstChunk) {
            spinner.stop(true);
            process.stdout.write(
              chalk.dim('─'.repeat(Math.min(process.stdout.columns ?? 80, 80))) + '\n'
            );
            updateStatusBar({ isThinking: 'medium' });
            firstChunk = false;
          }
          process.stdout.write(chunk);
          charCount += chunk.length;
          sessionLogger.logChunk(chunk);
        },
        {
          onToolStart: (name, args) => {
            spinner.setMode('tool-use', 'Using tools');
            const seqKey = `${name}#${toolCallSeq++}`;
            const idx = spinner.addToolLine(name, summarizeArgs(args));
            toolIndexMap.set(seqKey, idx);
            pendingToolKeys.push(seqKey);
            sessionLogger.logToolStart(name, args as Record<string, unknown>);
            updateStatusBar({ isThinking: 'medium' });
          },
          onToolEnd: (name, success, durationMs) => {
            const keyIdx = pendingToolKeys.findIndex((k) => k.startsWith(`${name}#`));
            if (keyIdx !== -1) {
              const seqKey = pendingToolKeys.splice(keyIdx, 1)[0]!;
              const lineIdx = toolIndexMap.get(seqKey) ?? -1;
              if (lineIdx >= 0) spinner.updateToolLine(lineIdx, success ? 'done' : 'error', durationMs);
            }
            sessionLogger.logToolEnd(name, success, durationMs);
          },
        },
      );

      if (firstChunk) {
        spinner.stop(true);
        process.stdout.write('\n');
      } else {
        spinner.stop(false);
        if (charCount > 0) {
          process.stdout.write(
            '\n' + chalk.dim('─'.repeat(Math.min(process.stdout.columns ?? 80, 80))) + '\n'
          );
        }
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
    rl.resume();
    rl.prompt(); printStatusBar();
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
          const { getMemoryStore } = await import('../../core/memory/memory-store.js');
          const store = getMemoryStore(process.cwd());
          const result = await store.ingest(history);
          if (result.added > 0) {
            process.stdout.write(chalk.gray(`\n🌙 Dream Mode: +${result.added} insights saved to memory.\n`));
          }
        } catch (err) { process.stderr.write(`[repl] Memory ingest failed: ${String(err)}\n`); }
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
