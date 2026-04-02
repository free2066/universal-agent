/**
 * uagent debug — Developer diagnostic tool
 *
 * Runs a comprehensive health check and prints a structured report:
 *   1. Environment & runtime info (Node version, OS, cwd)
 *   2. API key status for each provider (configured / missing)
 *   3. Connectivity ping for each configured provider
 *   4. Current model pointer configuration
 *   5. Recent error log (if any)
 *   6. Project config files (.env, .uagent/, .mcp.json, agents.md)
 *
 * Usage:
 *   uagent debug              — full report
 *   uagent debug --ping       — include live provider ping tests
 *   uagent debug --json       — output as JSON (for CI / bug reports)
 */

import chalk from 'chalk';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

// ── Provider check definitions ────────────────────────────────────────────────

interface ProviderCheck {
  name: string;
  envKey: string;
  pingUrl?: string;
  pingBody?: object;
  pingModelField?: string;
  pingModel?: string;
  authHeader?: (key: string) => Record<string, string>;
  isGemini?: boolean;
  geminiModel?: string;
}

const PROVIDERS: ProviderCheck[] = [
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    pingUrl: 'https://openrouter.ai/api/v1/models',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    isGemini: true,
    geminiModel: 'gemini-2.5-flash',
  },
  {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    pingUrl: 'https://api.groq.com/openai/v1/chat/completions',
    pingModel: 'llama-3.3-70b-versatile',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    name: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    pingUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    pingModel: 'Qwen/Qwen3-8B',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    pingUrl: 'https://api.deepseek.com/v1/chat/completions',
    pingModel: 'deepseek-chat',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    pingUrl: 'https://api.openai.com/v1/chat/completions',
    pingModel: 'gpt-4o-mini',
    authHeader: (k) => ({ 'Authorization': `Bearer ${k}` }),
  },
  {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    pingUrl: 'https://api.anthropic.com/v1/messages',
    authHeader: (k) => ({
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
    }),
  },
];

// ── Ping helpers ──────────────────────────────────────────────────────────────

type PingResult = 'ok' | 'auth_error' | 'rate_limit' | 'network_error' | 'skipped';

async function pingProvider(p: ProviderCheck, key: string): Promise<{ result: PingResult; statusCode?: number; latencyMs?: number }> {
  const start = Date.now();
  try {
    let res: Response;

    if (p.isGemini) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.geminiModel}:generateContent?key=${key}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
        signal: AbortSignal.timeout(8000),
      });
    } else if (p.pingUrl?.includes('/models')) {
      // Models list endpoint (OpenRouter)
      res = await fetch(p.pingUrl, {
        headers: { 'Content-Type': 'application/json', ...p.authHeader?.(key) },
        signal: AbortSignal.timeout(8000),
      });
    } else if (p.pingUrl) {
      // Chat completion endpoint
      const isAnthropic = p.name === 'Anthropic';
      const body = isAnthropic
        ? { model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
        : { model: p.pingModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
      res = await fetch(p.pingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...p.authHeader?.(key) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } else {
      return { result: 'skipped' };
    }

    const latencyMs = Date.now() - start;
    if (res.status === 200) return { result: 'ok', statusCode: 200, latencyMs };
    if (res.status === 401 || res.status === 403) return { result: 'auth_error', statusCode: res.status, latencyMs };
    if (res.status === 429) return { result: 'rate_limit', statusCode: 429, latencyMs };
    return { result: 'network_error', statusCode: res.status, latencyMs };
  } catch {
    return { result: 'network_error', latencyMs: Date.now() - start };
  }
}

// ── Ollama check ──────────────────────────────────────────────────────────────

async function checkOllama(): Promise<{ running: boolean; models: string[]; latencyMs?: number }> {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const start = Date.now();
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    return {
      running: true,
      models: (data.models ?? []).map((m) => m.name),
      latencyMs: Date.now() - start,
    };
  } catch {
    return { running: false, models: [] };
  }
}

// ── File checks ───────────────────────────────────────────────────────────────

function checkConfigFiles(cwd: string): Record<string, { exists: boolean; size?: number; preview?: string }> {
  const files: Record<string, string> = {
    '.env': join(cwd, '.env'),
    '.uagent/models.json': join(cwd, '.uagent', 'models.json'),
    '.uagent/agents.md': join(cwd, '.uagent', 'agents.md'),
    '.mcp.json': join(cwd, '.mcp.json'),
    'agents.md': join(cwd, 'agents.md'),
    '~/.uagent/.env': resolve(process.env.HOME ?? '~', '.uagent', '.env'),
  };
  const result: Record<string, { exists: boolean; size?: number; preview?: string }> = {};
  for (const [label, path] of Object.entries(files)) {
    if (!existsSync(path)) {
      result[label] = { exists: false };
    } else {
      const st = statSync(path);
      let preview: string | undefined;
      if (label.endsWith('.env')) {
        // Show key names only (mask values)
        try {
          const lines = readFileSync(path, 'utf-8').split('\n')
            .filter((l) => l.includes('=') && !l.startsWith('#'))
            .map((l) => {
              const k = l.split('=')[0];
              return `${k}=***`;
            });
          preview = lines.join(', ');
        } catch { /* ignore */ }
      }
      result[label] = { exists: true, size: st.size, preview };
    }
  }
  return result;
}

// ── Main report ───────────────────────────────────────────────────────────────

export interface DebugReport {
  timestamp: string;
  runtime: {
    node: string;
    platform: string;
    cwd: string;
    uagentVersion: string;
  };
  keys: Array<{ provider: string; envKey: string; configured: boolean; masked?: string }>;
  connectivity: Array<{ provider: string; result: PingResult; statusCode?: number; latencyMs?: number }>;
  models: {
    pointers: Record<string, string>;
    profiles: number;
  };
  ollama: { running: boolean; models: string[]; latencyMs?: number };
  files: Record<string, { exists: boolean; size?: number; preview?: string }>;
  issues: string[];
  suggestions: string[];
}

export async function runDebugCheck(opts: { ping?: boolean; json?: boolean } = {}): Promise<void> {
  const { ping = false, json = false } = opts;
  const cwd = process.cwd();

  if (!json) {
    console.log(chalk.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold.white('  🔍  Universal Agent — Debug Diagnostic') + chalk.cyan('                   ║'));
    console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════╝\n'));
  }

  // ── Runtime ──────────────────────────────────────────────────────────────
  let uagentVersion = '?';
  try {
    const pkgPath = resolve(cwd, 'package.json');
    const fallback = resolve(import.meta.url.replace('file://', ''), '../../../package.json');
    const p = existsSync(pkgPath) ? pkgPath : fallback;
    uagentVersion = JSON.parse(readFileSync(p, 'utf-8')).version ?? '?';
  } catch { /* ignore */ }

  const runtime = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cwd,
    uagentVersion,
  };

  // ── API Keys ─────────────────────────────────────────────────────────────
  const keys = PROVIDERS.map((p) => {
    const val = process.env[p.envKey];
    return {
      provider: p.name,
      envKey: p.envKey,
      configured: !!val,
      masked: val ? val.slice(0, 8) + '...' : undefined,
    };
  });

  // ── Connectivity ─────────────────────────────────────────────────────────
  let connectivity: DebugReport['connectivity'] = [];
  if (ping) {
    if (!json) process.stdout.write('🔌 Testing provider connectivity...\n');
    const checks = PROVIDERS
      .filter((p) => !!process.env[p.envKey])
      .map(async (p) => {
        const key = process.env[p.envKey]!;
        if (!json) process.stdout.write(`   Pinging ${p.name}...`);
        const r = await pingProvider(p, key);
        if (!json) {
          const icon = r.result === 'ok' ? chalk.green('✓') : r.result === 'auth_error' ? chalk.red('✗ auth') : chalk.yellow('⚠');
          const lat = r.latencyMs ? chalk.gray(` ${r.latencyMs}ms`) : '';
          process.stdout.write(` ${icon}${lat}\n`);
        }
        return { provider: p.name, ...r };
      });
    connectivity = await Promise.all(checks);
  }

  // ── Ollama ────────────────────────────────────────────────────────────────
  if (!json) process.stdout.write('🦙 Checking Ollama...');
  const ollama = await checkOllama();
  if (!json) {
    if (ollama.running) {
      process.stdout.write(chalk.green(` ✓ running (${ollama.models.length} model(s): ${ollama.models.slice(0, 3).join(', ')})\n`));
    } else {
      process.stdout.write(chalk.gray(' not running\n'));
    }
  }

  // ── Model pointers ────────────────────────────────────────────────────────
  let modelPointers: Record<string, string> = {};
  let profileCount = 0;
  try {
    const { modelManager } = await import('../models/model-manager.js');
    modelPointers = modelManager.getPointers() as unknown as Record<string, string>;
    profileCount = modelManager.listProfiles().length;
  } catch { /* ignore */ }

  // ── Files ─────────────────────────────────────────────────────────────────
  const files = checkConfigFiles(cwd);

  // ── Issues & suggestions ──────────────────────────────────────────────────
  const issues: string[] = [];
  const suggestions: string[] = [];

  const configuredKeys = keys.filter((k) => k.configured);
  if (configuredKeys.length === 0) {
    issues.push('No API keys configured — agent cannot call any LLM');
    suggestions.push('Run: uagent config  — to set up a free API key (OpenRouter recommended)');
  }

  if (ping) {
    const authFails = connectivity.filter((c) => c.result === 'auth_error');
    for (const f of authFails) {
      issues.push(`${f.provider}: API key configured but authentication failed (wrong key?)`);
      suggestions.push(`Run: uagent config  — to update ${f.provider} key`);
    }
    const netFails = connectivity.filter((c) => c.result === 'network_error');
    for (const f of netFails) {
      issues.push(`${f.provider}: network error (status ${f.statusCode ?? 'timeout'}) — firewall or endpoint issue?`);
    }
  }

  if (!files['.env'].exists && !files['~/.uagent/.env'].exists) {
    suggestions.push('Create a .env file in your project root with your API keys');
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const report: DebugReport = {
    timestamp: new Date().toISOString(),
    runtime,
    keys,
    connectivity,
    models: { pointers: modelPointers, profiles: profileCount },
    ollama,
    files,
    issues,
    suggestions,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Human-readable output ─────────────────────────────────────────────────
  console.log(chalk.yellow('📦 Runtime'));
  console.log(`   Node:     ${chalk.white(runtime.node)}`);
  console.log(`   Platform: ${chalk.white(runtime.platform)}`);
  console.log(`   Version:  ${chalk.white('v' + runtime.uagentVersion)}`);
  console.log(`   CWD:      ${chalk.gray(runtime.cwd)}`);

  console.log(chalk.yellow('\n🔑 API Keys'));
  for (const k of keys) {
    const icon = k.configured ? chalk.green('✓') : chalk.red('✗');
    const val = k.configured ? chalk.green(k.masked!) : chalk.gray('not set');
    console.log(`   ${icon} ${k.envKey.padEnd(28)} ${val}`);
  }

  if (connectivity.length > 0) {
    console.log(chalk.yellow('\n🌐 Connectivity'));
    for (const c of connectivity) {
      const icon = c.result === 'ok' ? chalk.green('✓') : c.result === 'auth_error' ? chalk.red('✗') : chalk.yellow('⚠');
      const detail = c.result === 'ok'
        ? chalk.green(`OK (${c.latencyMs}ms)`)
        : c.result === 'auth_error'
        ? chalk.red(`Auth failed (${c.statusCode})`)
        : c.result === 'rate_limit'
        ? chalk.yellow('Rate limited')
        : chalk.gray(`Error (${c.statusCode ?? 'timeout'})`);
      console.log(`   ${icon} ${c.provider.padEnd(16)} ${detail}`);
    }
  }

  console.log(chalk.yellow('\n🤖 Models'));
  for (const [ptr, model] of Object.entries(modelPointers)) {
    console.log(`   ${ptr.padEnd(10)} → ${chalk.white(model)}`);
  }
  console.log(`   ${chalk.gray(`(${profileCount} profiles registered)`)}`);

  console.log(chalk.yellow('\n🦙 Ollama'));
  if (ollama.running) {
    console.log(`   ${chalk.green('✓ Running')}  models: ${ollama.models.slice(0, 5).join(', ') || 'none installed'}`);
    if (ollama.models.length > 5) console.log(`   ${chalk.gray(`  ... and ${ollama.models.length - 5} more`)}`);
  } else {
    console.log(`   ${chalk.gray('Not running')}  (install: https://ollama.com → ollama pull qwen3)`);
  }

  console.log(chalk.yellow('\n📁 Config Files'));
  for (const [label, info] of Object.entries(files)) {
    const icon = info.exists ? chalk.green('✓') : chalk.gray('○');
    const detail = info.exists
      ? chalk.gray(`${info.size} bytes${info.preview ? ' — ' + info.preview : ''}`)
      : chalk.gray('not found');
    console.log(`   ${icon} ${label.padEnd(24)} ${detail}`);
  }

  if (issues.length > 0) {
    console.log(chalk.red('\n⚠  Issues Found'));
    for (const issue of issues) console.log(`   ${chalk.red('•')} ${issue}`);
  }

  if (suggestions.length > 0) {
    console.log(chalk.yellow('\n💡 Suggestions'));
    for (const s of suggestions) console.log(`   ${chalk.yellow('→')} ${s}`);
  }

  if (issues.length === 0) {
    console.log(chalk.green('\n✅ No issues detected!'));
  }

  if (!ping) {
    console.log(chalk.gray('\n  Tip: uagent debug --ping  — also test live connectivity to each provider'));
    console.log(chalk.gray('  Tip: uagent debug --json  — output as JSON for bug reports / CI\n'));
  } else {
    console.log();
  }
}
