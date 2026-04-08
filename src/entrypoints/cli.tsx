// @ts-nocheck
import { feature } from 'bun:bundle';
import '../macro.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// ── UA Multi-Model Bootstrap ──────────────────────────────────────────────────
// Read ~/.uagent/.env (旧 UA 存储 key 的地方) and ~/.uagent/models.json
// Set ANTHROPIC_MODEL + WQ_API_KEY + OPENAI_BASE_URL for MultiModelAnthropicAdapter
;(function bootstrapUAModel() {
  try {
    const { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } = require('fs')
    const { resolve, dirname } = require('path')
    const uagentDir = resolve(process.env.HOME || '~', '.uagent')

    // ── Step 0: Ensure ~/.claude.json has UA placeholder key approved ──────────
    // Prevents "Detected a custom API key" dialog on every startup
    try {
      const claudeConfigPath = resolve(process.env.HOME || '~', '.claude.json')
      const UA_KEY_NORMALIZED = 'ti-model-placeholder' // last 20 chars of 'ua-multi-model-placeholder'
      let claudeConfig: any = {}
      if (existsSync(claudeConfigPath)) {
        claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf8'))
      }
      const responses = claudeConfig.customApiKeyResponses ?? {}
      const approved: string[] = responses.approved ?? []
      const rejected: string[] = responses.rejected ?? []
      // 无论 onboarding 是否完成，始终确保 approved 列表正确
      // 这样选完主题（onboarding 完成）后就不会再弹 API key 确认框
      const needsApiKeyFix =
        !approved.includes(UA_KEY_NORMALIZED) ||
        rejected.includes(UA_KEY_NORMALIZED)
      if (needsApiKeyFix) {
        claudeConfig.customApiKeyResponses = {
          approved: [...new Set([...approved, UA_KEY_NORMALIZED])],
          rejected: rejected.filter((k: string) => k !== UA_KEY_NORMALIZED),
        }
        writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2))
      }
    } catch (_) {}

    // ── Step 0.1: Force full logo layout (Tips + Recent activity panels) ───────
    // CC 精简模式触发条件：lastReleaseNotesSeen === VERSION && !showProjectOnboarding
    // 由于 changelog 从 GitHub 异步加载，启动时缓存为空 → hasReleaseNotes=false → 精简模式
    // 用环境变量强制显示完整布局，无副作用
    process.env.CLAUDE_CODE_FORCE_FULL_LOGO = '1'

    // ── Step 1: Load ~/.uagent/.env first (旧 UA 的 key 存储) ──────────────────
    const envFile = resolve(uagentDir, '.env')
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const eq = line.indexOf('=')
        if (eq < 1) continue
        const k = line.slice(0, eq).trim()
        const v = line.slice(eq + 1).trim()
        if (k && v && !process.env[k]) {
          process.env[k] = v
        }
      }
    }

    // ── Step 2: Load ~/.uagent/models.json for model pointer ──────────────────
    const configFile = resolve(uagentDir, 'models.json')
    if (!existsSync(configFile)) return

    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    const mainModel = config?.pointers?.main
    if (!mainModel) return

    // Set the model for CC engine (UAGENT_MODEL from .env takes priority)
    if (!process.env.ANTHROPIC_MODEL) {
      process.env.ANTHROPIC_MODEL = process.env.UAGENT_MODEL || mainModel
    }

    // Setup UA debug log
    const uaLogFile = resolve(process.env.HOME || '~', '.claude', 'debug', 'ua-debug.log')
    try {
      mkdirSync(dirname(uaLogFile), { recursive: true })
      appendFileSync(uaLogFile, `\n[${new Date().toISOString()}] UA bootstrap: model=${process.env.ANTHROPIC_MODEL} baseURL=${process.env.OPENAI_BASE_URL || 'none'}\n`)
    } catch {}
    process.env.UA_DEBUG_LOG = uaLogFile

    const isAnthropicModel =
      process.env.ANTHROPIC_MODEL!.startsWith('claude-') ||
      process.env.ANTHROPIC_MODEL!.includes('anthropic.claude')

    if (!isAnthropicModel) {
      // Suppress Anthropic auth requirement
      if (!process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = 'ua-multi-model-placeholder'
      }

      // Load per-profile credentials if the profile has them and .env didn't set them
      const profiles: any[] = config.profiles || []
      const activeModel = process.env.ANTHROPIC_MODEL!
      const profile = profiles.find((p: any) => p.name === activeModel || p.modelName === activeModel)
      if (profile) {
        const { provider, apiKey, baseURL, displayName } = profile
        // 将友好名存到环境变量，供 LogoV2 的 billingType 显示
        if (displayName && !process.env.UA_MODEL_DISPLAY_NAME) {
          process.env.UA_MODEL_DISPLAY_NAME = displayName
        }
        if (provider === 'gemini' || activeModel.startsWith('gemini')) {
          if (apiKey && !process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = apiKey
        } else {
          // OpenAI-compat (ep-*, gpt-*, deepseek, etc.)
          if (apiKey && !process.env.WQ_API_KEY) process.env.WQ_API_KEY = apiKey
          if (apiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = apiKey
          if (baseURL && !process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = baseURL
        }
      }
    }
  } catch (_e) {
    // silently ignore config read errors
  }
})()
// ── /UA Multi-Model Bootstrap ─────────────────────────────────────────────────

// Set max heap size for child processes in CCR environments
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Fast-path for --version/-v
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    const pkg = await import('../../package.json');
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${(pkg as any).version ?? '0.5.23'} (Universal Agent)`);
    return;
  }

  // For all other paths, load the startup profiler
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // Fast-path for `--daemon-worker=<kind>` (internal)
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // Fast-path for `claude daemon [subcommand]`
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for `claude ps|logs|attach|kill` and `--bg`/`--background`
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  // Fast-path for --worktree --tmux
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // No special flags detected, load and run the full CLI
  const {
    startCapturingEarlyInput
  } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
