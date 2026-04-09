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
    const { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } = require('fs')
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

    // ── Step 2.1: Check ~/.claude/settings.json for persisted model (from /model command) ──
    // 优先级：ANTHROPIC_MODEL 环境变量 > settings.json 持久化（/model 命令写入）> UAGENT_MODEL > models.json default
    let persistedModel: string | undefined
    try {
      const settingsPath = resolve(process.env.HOME || '~', '.claude', 'settings.json')
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
        if (settings?.model && typeof settings.model === 'string') {
          persistedModel = settings.model
        }
      }
    } catch {}

    // Set the model for CC engine
    // 优先级：ANTHROPIC_MODEL 环境变量 > settings.json 持久化（/model 命令写入）> UAGENT_MODEL > models.json default
    if (!process.env.ANTHROPIC_MODEL) {
      process.env.ANTHROPIC_MODEL = persistedModel || process.env.UAGENT_MODEL || mainModel
    }

    // ── Step 2.2: Load router / fallback / taskTypes from models.json ──────────
    // router: { taskType: modelName } — 多模型动态路由映射表（未来自动路由用）
    // fallback: string[]             — 模型故障时的 fallback 链
    // profile.taskTypes: string[]   — 每个模型适合的任务类型（可选，不强制填写）
    if (config?.router && typeof config.router === 'object') {
      process.env.UA_TASK_ROUTER = JSON.stringify(config.router)
    }
    if (Array.isArray(config?.fallback) && config.fallback.length > 0) {
      process.env.UA_FALLBACK_CHAIN = JSON.stringify(config.fallback)
    }

    // ── Setup UA debug log ────────────────────────────────────────────────────
    const uaLogFile = resolve(process.env.HOME || '~', '.claude', 'debug', 'ua-debug.log')
    const uaLog = (msg: string) => {
      try { appendFileSync(uaLogFile, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
    }
    try { mkdirSync(dirname(uaLogFile), { recursive: true }) } catch {}
    process.env.UA_DEBUG_LOG = uaLogFile

    uaLog(`━━━ UA bootstrap start (pid=${process.pid}) ━━━`)
    uaLog(`version: ${process.env.npm_package_version ?? 'unknown'}`)
    uaLog(`node: ${process.version}  bun: ${(process.versions as any).bun ?? 'n/a'}`)
    uaLog(`cwd: ${process.cwd()}`)
    uaLog(`HOME: ${process.env.HOME}`)

    // ── Step 1 result
    uaLog(`[step1] .env file: ${existsSync(resolve(uagentDir, '.env')) ? 'found' : 'NOT FOUND'}`)
    uaLog(`[step1] WQ_API_KEY from .env: ${process.env.WQ_API_KEY ? '***' + process.env.WQ_API_KEY.slice(-4) : 'not set'}`)
    uaLog(`[step1] OPENAI_BASE_URL from .env: ${process.env.OPENAI_BASE_URL ?? 'not set'}`)

    // ── Step 2 result
    uaLog(`[step2] models.json: ${existsSync(configFile) ? 'found' : 'NOT FOUND'}`)
    uaLog(`[step2] pointers.main (default): ${mainModel}`)
    uaLog(`[step2] settings.json persisted model: ${persistedModel ?? 'none'}`)
    uaLog(`[step2] ANTHROPIC_MODEL (final): ${process.env.ANTHROPIC_MODEL} ${persistedModel && process.env.ANTHROPIC_MODEL === persistedModel ? '← from settings.json' : process.env.UAGENT_MODEL && process.env.ANTHROPIC_MODEL === process.env.UAGENT_MODEL ? '← from UAGENT_MODEL' : '← from models.json default'}`)
    uaLog(`[step2] profiles count: ${(config.profiles || []).length}`)
    uaLog(`[step2] router: ${process.env.UA_TASK_ROUTER ?? 'not configured'}`)
    uaLog(`[step2] fallback chain: ${process.env.UA_FALLBACK_CHAIN ?? 'not configured'}`)

    const isAnthropicModel =
      process.env.ANTHROPIC_MODEL!.startsWith('claude-') ||
      process.env.ANTHROPIC_MODEL!.includes('anthropic.claude')

    uaLog(`[step2] isAnthropicModel: ${isAnthropicModel}`)

    if (!isAnthropicModel) {
      // Suppress Anthropic auth requirement
      if (!process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = 'ua-multi-model-placeholder'
      }
      uaLog(`[step3] ANTHROPIC_API_KEY: placeholder set`)

      // Load per-profile credentials if the profile has them and .env didn't set them
      const profiles: any[] = config.profiles || []
      const activeModel = process.env.ANTHROPIC_MODEL!
      const profile = profiles.find((p: any) => p.name === activeModel || p.modelName === activeModel)

      if (profile) {
        const { provider, apiKey, baseURL, displayName } = profile
        uaLog(`[step3] profile found: name=${profile.name} provider=${provider} displayName=${displayName ?? 'n/a'}`)
        // 将友好名存到环境变量，供 LogoV2 的 billingType 显示
        if (displayName && !process.env.UA_MODEL_DISPLAY_NAME) {
          process.env.UA_MODEL_DISPLAY_NAME = displayName
          uaLog(`[step3] UA_MODEL_DISPLAY_NAME set: ${displayName}`)
        }
        if (provider === 'gemini' || activeModel.startsWith('gemini')) {
          if (apiKey && !process.env.GEMINI_API_KEY) {
            process.env.GEMINI_API_KEY = apiKey
            uaLog(`[step3] GEMINI_API_KEY set from profile (***${apiKey.slice(-4)})`)
          }
        } else {
          // OpenAI-compat (ep-*, gpt-*, deepseek, etc.)
          if (apiKey && !process.env.WQ_API_KEY) {
            process.env.WQ_API_KEY = apiKey
            uaLog(`[step3] WQ_API_KEY set from profile (***${apiKey.slice(-4)})`)
          }
          if (apiKey && !process.env.OPENAI_API_KEY) {
            process.env.OPENAI_API_KEY = apiKey
          }
          if (baseURL && !process.env.OPENAI_BASE_URL) {
            process.env.OPENAI_BASE_URL = baseURL
            uaLog(`[step3] OPENAI_BASE_URL set from profile: ${baseURL}`)
          }
        }
      } else {
        uaLog(`[step3] WARN: no profile found for model "${activeModel}" in profiles list`)
        uaLog(`[step3] available profile names: ${profiles.map((p: any) => p.name).join(', ')}`)
      }

      // UA: 把万擎 ep- 模型存到 UA_EXTRA_MODELS，供 /model 列表展示
      // 只收集有 displayName 的自定义 endpoint（ep- 前缀），避免与内置列表重复
      const extraModels = profiles
        .filter((p: any) => p.isActive !== false && p.name && p.displayName)
        .map((p: any) => ({
          name: p.name,
          displayName: p.displayName,
          contextLength: p.contextLength,
          inputLimit: p.inputLimit,  // UA P2: explicit input limit for overflow calculation
        }))
      if (extraModels.length > 0) {
        process.env.UA_EXTRA_MODELS = JSON.stringify(extraModels)
        uaLog(`[step3] UA_EXTRA_MODELS injected: ${extraModels.map((m: any) => m.displayName).join(', ')}`)
      }
    }

    uaLog(`[summary] ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL}`)
    uaLog(`[summary] OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL ?? 'NOT SET ⚠️'}`)
    uaLog(`[summary] WQ_API_KEY=${process.env.WQ_API_KEY ? '✓ set (***' + process.env.WQ_API_KEY.slice(-4) + ')' : 'NOT SET ⚠️'}`)
    uaLog(`[summary] GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? '✓ set' : 'not set'}`)
    // UA Task Router: log routing config summary at startup (sync — reads cached config)
    try {
      const { getTaskRouterSummary } = require('../utils/taskRouter.js')
      if (typeof getTaskRouterSummary === 'function') {
        uaLog(`[summary] ${getTaskRouterSummary()}`)
      }
    } catch {}
    // ── Setup session debug log (writes to fixed path, rotates daily) ────────
    // 使用 UA_SESSION_LOG_FILE 环境变量传递路径给 debug.ts 的 tee 写入器。
    // 不使用 --debug-file，避免触发 isDebugMode()=true（会显示 debug banner
    // 且将所有写入改为同步 appendFileSync，影响 UI 交互性能）。
    // 日志路径：~/.uagent/logs/session-YYYY-MM-DD.log
    const sessionLogDir = resolve(process.env.HOME || '~', '.uagent', 'logs')
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const sessionLogFile = resolve(sessionLogDir, `session-${today}.log`)
    try { mkdirSync(sessionLogDir, { recursive: true }) } catch {}

    // 只有用户没有手动指定 UA_SESSION_LOG_FILE 时才自动设置
    if (!process.env.UA_SESSION_LOG_FILE) {
      process.env.UA_SESSION_LOG_FILE = sessionLogFile
      uaLog(`[session-log] tee → ${sessionLogFile}`)
    } else {
      uaLog(`[session-log] using existing UA_SESSION_LOG_FILE=${process.env.UA_SESSION_LOG_FILE}`)
    }

    // 清理超过 7 天的旧 session 日志，防止磁盘累积
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      const files: string[] = readdirSync(sessionLogDir)
      for (const f of files) {
        if (!f.startsWith('session-') || !f.endsWith('.log')) continue
        const fp = resolve(sessionLogDir, f)
        try {
          const st = statSync(fp)
          if (st.mtimeMs < cutoff) {
            unlinkSync(fp)
            uaLog(`[session-log] cleaned up old log: ${f}`)
          }
        } catch {}
      }
    } catch {}

    uaLog(`━━━ UA bootstrap done ━━━`)
  } catch (_e: any) {
    // 即使日志失败也不影响启动，但尝试记录错误
    try {
      const { appendFileSync, mkdirSync } = require('fs')
      const { resolve, dirname } = require('path')
      const f = resolve(process.env.HOME || '~', '.claude', 'debug', 'ua-debug.log')
      mkdirSync(dirname(f), { recursive: true })
      appendFileSync(f, `[${new Date().toISOString()}] BOOTSTRAP ERROR: ${_e?.message ?? _e}\n`)
    } catch {}
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

  // ── UA: Fast-path for `uagent update` ────────────────────────────────────────
  // 从 GitHub 拉取最新版本并重新构建安装
  if (args[0] === 'update') {
    const { spawnSync } = require('child_process') as typeof import('child_process')
    const { resolve } = require('path') as typeof import('path')
    const { existsSync } = require('fs') as typeof import('fs')

    // 找到 uagent 安装目录（package.json 所在位置）
    const scriptPath = process.argv[1]!
    // dist/entrypoints/cli.js → 项目根目录
    const pkgRoot = resolve(scriptPath, '../../..')
    const pkgJson = resolve(pkgRoot, 'package.json')

    if (!existsSync(pkgJson)) {
      process.stderr.write(`[uagent update] Cannot find package.json at ${pkgJson}\n`)
      process.stderr.write(`[uagent update] Please update manually: cd <uagent-dir> && git pull && bun run build && npm link --force\n`)
      process.exit(1)
    }

    console.log(`[uagent update] Updating from ${pkgRoot} ...`)

    // Step 1: git pull
    console.log('\n[1/3] Pulling latest changes from GitHub...')
    const pull = spawnSync('git', ['pull'], { cwd: pkgRoot, stdio: 'inherit', encoding: 'utf8' })
    if (pull.status !== 0) {
      process.stderr.write(`[uagent update] git pull failed (exit ${pull.status})\n`)
      process.exit(pull.status ?? 1)
    }

    // Step 2: bun run build
    console.log('\n[2/3] Building...')
    const build = spawnSync('bun', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit', encoding: 'utf8' })
    if (build.status !== 0) {
      process.stderr.write(`[uagent update] build failed (exit ${build.status})\n`)
      process.exit(build.status ?? 1)
    }

    // Step 3: npm link
    console.log('\n[3/3] Linking...')
    const link = spawnSync('npm', ['link', '--force'], { cwd: pkgRoot, stdio: 'inherit', encoding: 'utf8' })
    if (link.status !== 0) {
      process.stderr.write(`[uagent update] npm link failed (exit ${link.status})\n`)
      process.exit(link.status ?? 1)
    }

    // 读取新版本号
    try {
      const newPkg = JSON.parse(require('fs').readFileSync(pkgJson, 'utf8'))
      console.log(`\n✅ uagent updated to v${newPkg.version}`)
    } catch {
      console.log('\n✅ uagent update complete')
    }
    process.exit(0)
  }
  // ── /UA: uagent update ────────────────────────────────────────────────────────

  // ── UA: Fast-path for `uagent init` ──────────────────────────────────────────
  // 分析当前目录结构，生成 CLAUDE.md 项目记忆模板
  if (args[0] === 'init') {
    const { existsSync: _exists, readFileSync: _read, writeFileSync: _write } = require('fs') as typeof import('fs')
    const { resolve: _resolve, basename: _basename } = require('path') as typeof import('path')
    const cwd = process.cwd()
    const claudeMdPath = _resolve(cwd, 'CLAUDE.md')

    if (_exists(claudeMdPath)) {
      process.stderr.write(`[uagent init] CLAUDE.md already exists at ${claudeMdPath}\n`)
      process.stderr.write(`[uagent init] Delete it first if you want to regenerate.\n`)
      process.exit(1)
    }

    console.log(`[uagent init] Analyzing ${cwd} ...`)

    // 检测语言/框架/构建工具
    const projectName = _basename(cwd)
    let lang = 'Unknown'
    let framework = ''
    let buildTool = ''
    let description = ''
    let buildCmd = ''
    let testCmd = ''
    let startCmd = ''
    let srcDirs: string[] = []

    // Node.js / TypeScript
    if (_exists(_resolve(cwd, 'package.json'))) {
      try {
        const pkg = JSON.parse(_read(_resolve(cwd, 'package.json'), 'utf8'))
        lang = _exists(_resolve(cwd, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript'
        description = pkg.description || ''
        buildTool = Object.keys(pkg.devDependencies || {}).includes('vite') ? 'Vite'
          : Object.keys(pkg.devDependencies || {}).includes('webpack') ? 'Webpack'
          : Object.keys(pkg.devDependencies || {}).includes('bun') ? 'Bun'
          : 'npm'
        if (pkg.dependencies?.['react'] || pkg.devDependencies?.['react']) framework = 'React'
        else if (pkg.dependencies?.['vue'] || pkg.devDependencies?.['vue']) framework = 'Vue'
        else if (pkg.dependencies?.['express']) framework = 'Express'
        else if (pkg.dependencies?.['next']) framework = 'Next.js'
        buildCmd = pkg.scripts?.build ? `npm run build` : ''
        testCmd = pkg.scripts?.test ? `npm test` : ''
        startCmd = pkg.scripts?.start ? `npm start` : pkg.scripts?.dev ? `npm run dev` : ''
      } catch {}
    }
    // Java / Maven
    else if (_exists(_resolve(cwd, 'pom.xml'))) {
      lang = 'Java'
      buildTool = 'Maven'
      buildCmd = 'mvn compile'
      testCmd = 'mvn test'
      startCmd = 'mvn spring-boot:run'
      try {
        const pom = _read(_resolve(cwd, 'pom.xml'), 'utf8')
        if (pom.includes('spring-boot')) framework = 'Spring Boot'
        else if (pom.includes('quarkus')) framework = 'Quarkus'
      } catch {}
    }
    // Java / Gradle
    else if (_exists(_resolve(cwd, 'build.gradle')) || _exists(_resolve(cwd, 'build.gradle.kts'))) {
      lang = _exists(_resolve(cwd, 'build.gradle.kts')) ? 'Kotlin' : 'Java'
      buildTool = 'Gradle'
      buildCmd = './gradlew build'
      testCmd = './gradlew test'
      startCmd = './gradlew bootRun'
    }
    // Python
    else if (_exists(_resolve(cwd, 'requirements.txt')) || _exists(_resolve(cwd, 'pyproject.toml'))) {
      lang = 'Python'
      buildTool = _exists(_resolve(cwd, 'pyproject.toml')) ? 'Poetry/pip' : 'pip'
      buildCmd = ''
      testCmd = 'pytest'
      startCmd = 'python main.py'
    }
    // Go
    else if (_exists(_resolve(cwd, 'go.mod'))) {
      lang = 'Go'
      buildTool = 'Go Modules'
      buildCmd = 'go build ./...'
      testCmd = 'go test ./...'
      startCmd = 'go run main.go'
    }
    // Rust
    else if (_exists(_resolve(cwd, 'Cargo.toml'))) {
      lang = 'Rust'
      buildTool = 'Cargo'
      buildCmd = 'cargo build'
      testCmd = 'cargo test'
      startCmd = 'cargo run'
    }

    // 检测常见目录
    const dirs = ['src', 'lib', 'app', 'tests', 'test', 'docs', 'api', 'scripts', 'config', 'resources']
    srcDirs = dirs.filter(d => _exists(_resolve(cwd, d)))

    // 生成 CLAUDE.md
    const techStack = [lang, framework, buildTool].filter(Boolean).join(' · ')
    const cmdSection = [
      buildCmd ? `# 构建\n${buildCmd}` : '',
      testCmd ? `# 测试\n${testCmd}` : '',
      startCmd ? `# 启动\n${startCmd}` : '',
    ].filter(Boolean).join('\n\n')

    const dirSection = srcDirs.length > 0
      ? srcDirs.map(d => `- \`${d}/\` — `).join('\n')
      : '- `src/` — 源代码'

    const content = `# ${projectName}
${description ? `\n> ${description}\n` : ''}
## 项目概述

[在这里描述项目的主要功能和业务背景]

## 技术栈

- 语言/框架：${techStack || 'Unknown'}
- 构建工具：${buildTool || '未检测到'}

## 常用命令

\`\`\`bash
${cmdSection || '# 请在此填写常用命令'}
\`\`\`

## 目录结构

${dirSection}

## 编码规范

- [在这里填写项目的编码规范]

## 注意事项

- [在这里填写重要的项目约束、已知问题或特殊配置]
`

    _write(claudeMdPath, content, 'utf8')
    console.log(`\n✅ CLAUDE.md created at ${claudeMdPath}`)
    console.log(`\n📝 Next steps:`)
    console.log(`  1. 编辑 CLAUDE.md，补充项目概述和注意事项`)
    console.log(`  2. 运行 uagent 时会自动读取 CLAUDE.md 作为项目上下文`)
    process.exit(0)
  }
  // ── /UA: uagent init ──────────────────────────────────────────────────────────

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
