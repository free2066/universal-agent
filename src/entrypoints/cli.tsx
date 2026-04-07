// @ts-nocheck
import { feature } from 'bun:bundle';
import '../macro.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// ── UA Multi-Model Bootstrap ──────────────────────────────────────────────────
// Read ~/.uagent/models.json and set ANTHROPIC_MODEL to the active main model
// so CC's engine routes to the correct provider via MultiModelAnthropicAdapter.
// Also loads per-profile apiKey and baseURL into the correct env vars.
;(function bootstrapUAModel() {
  try {
    const { readFileSync, existsSync } = require('fs')
    const { resolve } = require('path')
    const configFile = resolve(process.env.HOME || '~', '.uagent', 'models.json')
    if (!existsSync(configFile)) return

    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    const mainModel = config?.pointers?.main
    if (!mainModel) return

    // Set the model for CC engine
    if (!process.env.ANTHROPIC_MODEL) {
      process.env.ANTHROPIC_MODEL = mainModel
    }

    const isAnthropicModel =
      mainModel.startsWith('claude-') || mainModel.includes('anthropic.claude')

    if (!isAnthropicModel) {
      // Suppress Anthropic auth requirement
      if (!process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = 'ua-multi-model-placeholder'
      }

      // Load per-profile credentials if the profile has them
      const profiles: any[] = config.profiles || []
      const profile = profiles.find((p: any) => p.name === mainModel || p.modelName === mainModel)
      if (profile) {
        const { provider, apiKey, baseURL } = profile

        // Anthropic
        if ((provider === 'anthropic' || mainModel.startsWith('claude'))) {
          if (apiKey && !process.env.ANTHROPIC_API_KEY_REAL) {
            process.env.ANTHROPIC_API_KEY = apiKey
          }
        }
        // Gemini
        else if (provider === 'gemini' || mainModel.startsWith('gemini')) {
          if (apiKey && !process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = apiKey
        }
        // OpenAI / Wanqing ep-* / DeepSeek / Moonshot / Qwen / Mistral / Groq / SiliconFlow / OpenRouter
        else {
          if (apiKey) {
            if (!process.env.WQ_API_KEY) process.env.WQ_API_KEY = apiKey
            if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = apiKey
          }
          if (baseURL && !process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = baseURL
        }
      }

      // Wanqing ep-* models: load global WQ config if no per-profile key
      if ((mainModel.startsWith('ep-') || mainModel.startsWith('api-')) &&
          !process.env.WQ_API_KEY && !process.env.OPENAI_API_KEY) {
        const globalKey = config.wqApiKey || config.openaiApiKey
        const globalBase = config.openaiBaseUrl || config.wqBaseUrl
        if (globalKey) {
          process.env.WQ_API_KEY = globalKey
          process.env.OPENAI_API_KEY = globalKey
        }
        if (globalBase && !process.env.OPENAI_BASE_URL) {
          process.env.OPENAI_BASE_URL = globalBase
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
