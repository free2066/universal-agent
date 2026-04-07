import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ModelProfile, ModelPointers } from '../models/model-manager.js';

// Read package.json version once at module load time
const _pkgVersion = (() => {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(__dir, '../../package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch { return ''; }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// 现代化 UI 组件库 - 为 Universal Agent CLI 提供美观的交互界面
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 颜色主题配置 ─────────────────────────────────────────────────────────────
const theme = {
  primary: chalk.hex('#6366f1'),      // Indigo
  primaryLight: chalk.hex('#818cf8'), // Light Indigo
  secondary: chalk.hex('#10b981'),    // Emerald
  accent: chalk.hex('#f59e0b'),       // Amber
  danger: chalk.hex('#ef4444'),       // Red
  warning: chalk.hex('#f97316'),      // Orange
  info: chalk.hex('#3b82f6'),         // Blue
  muted: chalk.hex('#6b7280'),        // Gray
  dark: chalk.hex('#1f2937'),         // Dark Gray
  white: chalk.white,
  bg: {
    primary: chalk.bgHex('#6366f1'),
    secondary: chalk.bgHex('#10b981'),
    dark: chalk.bgHex('#1f2937'),
  }
};

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 居中显示文本 */
function center(text: string, width: number = 50): string {
  const padding = Math.max(0, width - text.length);
  const left = Math.floor(padding / 2);
  return ' '.repeat(left) + text + ' '.repeat(padding - left);
}

/** 创建分隔线 */
function divider(char: string = '─', length: number = 50): string {
  return theme.muted(char.repeat(length));
}

/** 截断文本 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ─── 现代化 Banner ────────────────────────────────────────────────────────────

export function printBanner() {
  const verLabel = _pkgVersion ? ` v${_pkgVersion}` : '';
  const lines = [
    '',
    theme.primary('    ██╗   ██╗███╗   ██╗██╗██╗   ██╗███████╗██████╗ ███████╗ █████╗ ██╗     '),
    theme.primary('    ██║   ██║████╗  ██║██║██║   ██║██╔════╝██╔══██╗██╔════╝██╔══██╗██║     '),
    theme.primary('    ██║   ██║██╔██╗ ██║██║██║   ██║█████╗  ██████╔╝█████╗  ███████║██║     '),
    theme.primary('    ██║   ██║██║╚██╗██║██║╚██╗ ██╔╝██╔══╝  ██╔══██╗██╔══╝  ██╔══██║██║     '),
    theme.primary('    ╚██████╔╝██║ ╚████║██║ ╚████╔╝ ███████╗██║  ██║███████╗██║  ██║███████╗'),
    theme.primary('     ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝'),
    '',
    theme.muted(center(`Universal Agent CLI${verLabel}`, 77)),
    theme.primaryLight(center('Multi-domain AI Powered Assistant', 77)),
    '',
  ];
  
  console.log(lines.join('\n'));
  printDomainChips();
  console.log('');
}

/** 显示 Domain 标签 */
function printDomainChips() {
  const domains = [
    { name: 'data', icon: '📊', color: theme.info, desc: 'Data Analysis' },
    { name: 'dev', icon: '💻', color: theme.secondary, desc: 'Development' },
    { name: 'service', icon: '🎧', color: theme.accent, desc: 'Customer Service' },
    { name: 'auto', icon: '🤖', color: theme.primary, desc: 'Auto-detect' },
  ];
  
  const chips = domains.map(d => 
    d.color(` ${d.icon} ${d.name} `)
  ).join(theme.muted(' │ '));
  
  console.log('  ' + theme.muted('Domains: ') + chips);
}

// ─── 现代化帮助页面 ───────────────────────────────────────────────────────────

export function printHelp() {
  const sections = [
    {
      title: '📚 Session',
      commands: [
        { cmd: '/help', desc: 'Show this help message', example: '' },
        { cmd: '/clear', desc: 'Clear conversation history', example: '' },
        { cmd: '/exit', desc: 'Exit the agent', example: '' },
        { cmd: '/log', desc: 'Show current session log path', example: '' },
        { cmd: '/logs', desc: 'List all saved session logs', example: '' },
        { cmd: '/resume [id]', desc: 'Resume a previous session', example: '/resume abc123' },
        { cmd: '/branch', desc: 'Branch current session', example: '' },
        { cmd: '/rename <name>', desc: 'Rename current session', example: '/rename my-task' },
        { cmd: '/export [path]', desc: 'Export session transcript', example: '/export out.md' },
        { cmd: '/copy', desc: 'Copy last response to clipboard', example: '' },
        { cmd: '/status', desc: 'Show session status summary', example: '' },
        { cmd: '/bug [desc]', desc: 'File a bug report', example: '/bug tool crashed' },
      ]
    },
    {
      title: '⚙️  Configuration',
      commands: [
        { cmd: '/domain <name>', desc: 'Switch domain (auto/dev/data/service)', example: '/domain data' },
        { cmd: '/model [name]', desc: 'Switch or show model', example: '/model claude-opus-4' },
        { cmd: '/models', desc: 'List configured models', example: '' },
        { cmd: '/config [key] [val]', desc: 'Get/set a config value', example: '/config theme dark' },
        { cmd: '/output-style <s>', desc: 'Set output style preset or file', example: '/output-style Concise' },
        { cmd: '/cost', desc: 'Show token usage & estimated cost', example: '' },
        { cmd: '/history [n]', desc: 'Show last n prompts', example: '/history 10' },
        { cmd: '/upgrade', desc: 'Check for updates and upgrade', example: '' },
      ]
    },
    {
      title: '🧠 Context & Memory',
      commands: [
        { cmd: '/context', desc: 'Show context window stats (13 dimensions)', example: '' },
        { cmd: '/compact', desc: 'Compress context with LLM summary', example: '' },
        { cmd: '/tokens', desc: 'Quick token usage summary', example: '' },
        { cmd: '/memory [op]', desc: 'View/edit memory files', example: '/memory show' },
        { cmd: '/init', desc: 'Create AGENTS.md in current dir', example: '' },
        { cmd: '/rules', desc: 'Show active rules (AGENTS.md chain)', example: '' },
        { cmd: '/review', desc: 'Review recent code changes', example: '' },
        { cmd: '/spec [topic]', desc: 'Create a feature spec', example: '/spec auth flow' },
        { cmd: '/spec:brainstorm', desc: 'Brainstorm a spec topic', example: '' },
        { cmd: '/spec:write-plan', desc: 'Write plan from spec', example: '' },
        { cmd: '/spec:execute-plan', desc: 'Execute the current plan', example: '' },
        { cmd: '/rewind [n]', desc: 'Undo last n agent turns', example: '/rewind 2' },
      ]
    },
    {
      title: '🛠️  Tools & Actions',
      commands: [
        { cmd: '/inspect [path]', desc: 'Static code inspection', example: '/inspect src/' },
        { cmd: '/purify [path]', desc: 'Auto-fix code issues', example: '/purify --dry-run' },
        { cmd: '/commit [msg]', desc: 'Commit staged changes', example: '/commit fix: typo' },
        { cmd: '/diff', desc: 'Show current git diff', example: '' },
        { cmd: '/effort [h]', desc: 'Set effort/time budget', example: '/effort 2h' },
        { cmd: '/security-review', desc: 'Run security audit', example: '' },
        { cmd: '/add-dir <path>', desc: 'Add directory to context', example: '/add-dir ./data' },
        { cmd: '/image <path>', desc: 'Add image to context', example: '/image screenshot.png' },
        { cmd: '/permissions', desc: 'Show permission settings', example: '' },
        { cmd: '/thinkback [n]', desc: 'Re-examine last n turns', example: '/thinkback 3' },
        { cmd: '/search <q>', desc: 'Search session history', example: '/search OAuth' },
      ]
    },
    {
      title: '🤖 Agents & MCP',
      commands: [
        { cmd: '/agents', desc: 'List available subagents', example: '' },
        { cmd: '/mcp', desc: 'Show MCP server status', example: '' },
        { cmd: '/skills', desc: 'List available skills', example: '' },
        { cmd: '/plugin [op]', desc: 'Manage domain plugins', example: '/plugin list' },
        { cmd: '/plugins', desc: 'Show active domain plugins', example: '' },
        { cmd: '/hooks [op]', desc: 'Manage lifecycle hooks', example: '/hooks list' },
        { cmd: '/team', desc: 'Show team configuration', example: '' },
        { cmd: '/inbox', desc: 'Show incoming team messages', example: '' },
        { cmd: '/tasks', desc: 'Show background tasks', example: '' },
      ]
    },
    {
      title: '🔐 Auth & Profile',
      commands: [
        { cmd: '/login', desc: 'Authenticate with provider', example: '' },
        { cmd: '/logout', desc: 'Clear authentication tokens', example: '' },
        { cmd: '/ide', desc: 'Show IDE integration status', example: '' },
        { cmd: '/stats', desc: 'Show usage statistics', example: '' },
        { cmd: '/doctor', desc: 'Run environment diagnostics', example: '' },
        { cmd: '/plan [op]', desc: 'Enter/manage plan mode', example: '/plan start' },
        { cmd: '/metrics', desc: 'Show session metrics', example: '' },
        { cmd: '/insights [n]', desc: 'Show memory insights', example: '/insights 5' },
        { cmd: '/terminal-setup', desc: 'Configure terminal integration', example: '' },
      ]
    },
  ];

  console.log('');
  console.log(divider('═', 70));

  for (const section of sections) {
    console.log('');
    console.log('  ' + theme.accent(section.title));
    console.log('  ' + divider('─', 50));

    for (const { cmd, desc, example } of section.commands) {
      const cmdStr = theme.white(cmd.padEnd(22));
      const descStr = theme.muted(desc);
      console.log(`    ${cmdStr} ${descStr}`);
      if (example) {
        console.log(`    ${' '.repeat(22)} ${theme.secondary('→ ' + example)}`);
      }
    }
  }

  console.log('');
  console.log(theme.muted('  💡 Custom commands: .uagent/commands/<name>.md  |  Plugin commands: /plugins'));
  console.log('');
  console.log(divider('═', 70));
  printExamplePrompts();
}

/** 显示示例提示 */
function printExamplePrompts() {
  console.log('');
  console.log('  ' + theme.secondary('💡 Example Prompts'));
  console.log('  ' + divider('─', 50));
  
  const examples = [
    { domain: 'data', icon: '📊', prompt: 'Analyze this CSV file for user retention' },
    { domain: 'data', icon: '📊', prompt: 'Generate EDA report for sales.csv' },
    { domain: 'dev', icon: '💻', prompt: 'Review this Python function for bugs' },
    { domain: 'dev', icon: '💻', prompt: 'Write unit tests for my auth module' },
    { domain: 'service', icon: '🎧', prompt: 'Classify this customer complaint' },
    { domain: 'auto', icon: '🤖', prompt: '@run-agent-reviewer check src/api.ts' },
  ];
  
  for (const { domain, icon, prompt } of examples) {
    const domainColor = getDomainColor(domain);
    console.log(`    ${domainColor(`[${domain}]`)} ${icon} "${theme.white(prompt)}"`);
  }
  
  console.log('');
}

function getDomainColor(domain: string) {
  const colors: Record<string, typeof theme.info> = {
    data: theme.info,
    dev: theme.secondary,
    service: theme.accent,
    auto: theme.primary,
  };
  return colors[domain] || theme.muted;
}

// ─── 模型列表显示 ─────────────────────────────────────────────────────────────

export function printModelsList(
  profiles: ModelProfile[],
  pointers: ModelPointers,
  activeModel: string
) {
  console.log('');
  console.log('  ' + theme.primary('🤖 Model Profiles'));
  console.log('  ' + divider('═', 60));
  
  // 按 provider 分组
  const byProvider: Record<string, ModelProfile[]> = {};
  for (const p of profiles) {
    if (!byProvider[p.provider]) byProvider[p.provider] = [];
    byProvider[p.provider].push(p);
  }
  
  const providerEmojis: Record<string, string> = {
    openai: '🅾️ ',
    anthropic: '🅰️ ',
    gemini: '🔷',
    deepseek: '🔮',
    moonshot: '🌙',
    qwen: '🔶',
    mistral: '🌪️ ',
    ollama: '🦙',
    custom: '⚙️ ',
  };
  
  for (const [provider, models] of Object.entries(byProvider)) {
    console.log('');
    const emoji = providerEmojis[provider] || '🔹';
    console.log(`  ${emoji} ${theme.accent(provider.toUpperCase())}`);
    console.log('  ' + divider('─', 50));
    
    for (const model of models) {
      const isActive = model.name === activeModel;
      const isPointer = Object.values(pointers).includes(model.name);
      
      let status = '  ○';
      if (isActive) status = theme.secondary('  ●');
      else if (isPointer) status = theme.info('  ◐');
      
      const name = isActive ? theme.white.bold(model.name) : theme.white(model.name);
      const modelId = theme.muted(model.modelName);
      
      let roles = '';
      if (isPointer) {
        const rolesList = Object.entries(pointers)
          .filter(([, v]) => v === model.name)
          .map(([k]) => k);
        roles = theme.secondary(` [${rolesList.join('/')}]`);
      }
      
      console.log(`${status} ${name.padEnd(22)} ${modelId}${roles}`);
      
      // 显示成本信息（可选）
      if (model.costPer1kInput > 0) {
        const cost = theme.muted(`    $${model.costPer1kInput}/1K in, $${model.costPer1kOutput}/1K out`);
        console.log(cost);
      }
    }
  }
  
  console.log('');
}

// ─── Agents 列表显示 ──────────────────────────────────────────────────────────

export function printAgentsList(agents: Array<{ name: string; description: string }>) {
  console.log('');
  console.log('  ' + theme.primary('👤 Available Subagents'));
  console.log('  ' + divider('═', 70));
  console.log('');
  
  for (const agent of agents) {
    const mention = theme.secondary(`@run-agent-${agent.name}`);
    const desc = theme.muted(agent.description);
    console.log(`    ${mention.padEnd(25)} ${desc}`);
  }
  
  console.log('');
  console.log('  ' + theme.muted('💡 Tip: Use @run-agent-<name> in your prompt to delegate tasks'));
  console.log('');
}

// ─── Domain 列表显示 ──────────────────────────────────────────────────────────

export function printDomainsList(domains: Array<{ name: string; description: string; tools: string[] }>) {
  console.log('');
  console.log('  ' + theme.primary('🌐 Available Domains'));
  console.log('  ' + divider('═', 70));
  console.log('');
  
  const icons: Record<string, string> = {
    data: '📊',
    dev: '💻',
    service: '🎧',
    auto: '🤖',
  };
  
  const colors: Record<string, typeof theme.info> = {
    data: theme.info,
    dev: theme.secondary,
    service: theme.accent,
    auto: theme.primary,
  };
  
  for (const domain of domains) {
    const icon = icons[domain.name] || '🔹';
    const color = colors[domain.name] || theme.white;
    
    console.log(`  ${icon} ${color.bold(domain.name.toUpperCase())}`);
    console.log(`     ${theme.muted(domain.description)}`);
    
    if (domain.tools.length > 0) {
      const toolsStr = domain.tools.map(t => theme.info(t)).join(theme.muted(', '));
      console.log(`     ${theme.muted('Tools:')} ${toolsStr}`);
    }
    console.log('');
  }
}

// ─── MCP 服务器列表 ───────────────────────────────────────────────────────────

export function printMCPServersList(servers: Array<{ name: string; type: string; enabled: boolean; url?: string }>) {
  console.log('');
  console.log('  ' + theme.primary('🔌 MCP Servers'));
  console.log('  ' + divider('═', 60));
  console.log('');
  
  if (servers.length === 0) {
    console.log('  ' + theme.muted('No MCP servers configured.'));
    console.log('  ' + theme.muted('Run `uagent mcp init` to create a configuration file.'));
    console.log('');
    return;
  }
  
  for (const server of servers) {
    const status = server.enabled 
      ? theme.secondary('● enabled ') 
      : theme.muted('○ disabled');
    const name = theme.white(server.name);
    const type = theme.muted(`[${server.type}]`);
    const url = server.url ? theme.muted(server.url) : '';
    
    console.log(`  ${status} ${name} ${type} ${url}`);
  }
  
  console.log('');
}

// ─── 成本摘要显示 ─────────────────────────────────────────────────────────────

export function printCostSummary(summary: {
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCost: number;
  pointers: ModelPointers;
}) {
  console.log('');
  console.log('  ' + theme.primary('📊 Session Cost Summary'));
  console.log('  ' + divider('═', 50));
  console.log('');
  
  const tokens = [
    { label: 'Input Tokens', value: summary.sessionInputTokens.toLocaleString(), color: theme.info },
    { label: 'Output Tokens', value: summary.sessionOutputTokens.toLocaleString(), color: theme.secondary },
    { label: 'Total Cost', value: `$${summary.sessionCost.toFixed(4)}`, color: theme.accent },
  ];
  
  for (const { label, value, color } of tokens) {
    console.log(`    ${theme.muted(label.padEnd(15))} ${color(value)}`);
  }
  
  console.log('');
  console.log('  ' + theme.muted('Model Pointers:'));
  for (const [key, value] of Object.entries(summary.pointers)) {
    console.log(`    ${theme.muted(key.padEnd(10))} ${theme.white(value)}`);
  }
  
  console.log('');
}

// ─── 历史记录显示 ─────────────────────────────────────────────────────────────

export function printHistory(entries: string[], count: number) {
  console.log('');
  console.log(`  ${theme.primary('📜 Recent History')} ${theme.muted(`(showing ${entries.length})`)}`);
  console.log('  ' + divider('═', 70));
  console.log('');
  
  if (entries.length === 0) {
    console.log('  ' + theme.muted('No history entries found.'));
  } else {
    entries.forEach((entry, i) => {
      const num = theme.muted(String(i + 1).padStart(3) + '.');
      const text = truncate(entry, 65);
      console.log(`  ${num} ${theme.white(text)}`);
    });
  }
  
  console.log('');
}

// ─── 状态指示器 ───────────────────────────────────────────────────────────────

export function printStatusIndicator(domain: string, model: string, isThinking = false) {
  const domainColor = getDomainColor(domain);
  const status = isThinking 
    ? theme.accent('⏳ thinking...')
    : theme.secondary('● ready');
  
  const line = `${status} ${domainColor(`[${domain}]`)} ${theme.muted('|')} ${theme.white(model)}`;
  process.stdout.write(`\r  ${line.padEnd(60)}`);
}

// ─── 错误消息显示 ─────────────────────────────────────────────────────────────

export function printError(message: string, suggestion?: string) {
  console.log('');
  console.log('  ' + theme.danger('❌ Error'));
  console.log('  ' + divider('─', 50));
  console.log('  ' + theme.white(message));
  
  if (suggestion) {
    console.log('');
    console.log('  ' + theme.secondary('💡 Suggestion:'));
    console.log('  ' + theme.muted(suggestion));
  }
  
  console.log('');
}

export function printWarning(message: string) {
  console.log('');
  console.log('  ' + theme.warning('⚠️  Warning'));
  console.log('  ' + theme.white(message));
  console.log('');
}

export function printSuccess(message: string) {
  console.log('  ' + theme.secondary('✅ ' + message));
}

// ─── 加载动画 ─────────────────────────────────────────────────────────────────

export function createSpinner(text: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let timer: NodeJS.Timeout | null = null;
  
  return {
    start() {
      timer = setInterval(() => {
        process.stdout.write(`\r  ${theme.accent(frames[i])} ${theme.muted(text)}`);
        i = (i + 1) % frames.length;
      }, 80);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null; // prevent duplicate clearInterval + double stdout write on repeated stop()
        process.stdout.write('\r' + ' '.repeat(text.length + 4) + '\r');
      }
    },
    succeed(msg?: string) {
      this.stop();
      console.log('  ' + theme.secondary('✓ ' + (msg || text)));
    },
    fail(msg?: string) {
      this.stop();
      console.log('  ' + theme.danger('✗ ' + (msg || text)));
    }
  };
}

// ─── 进度条 ───────────────────────────────────────────────────────────────────

export function printProgressBar(current: number, total: number, label?: string) {
  const width = 30;
  const percent = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((width * percent) / 100);
  const empty = width - filled;
  
  const bar = theme.secondary('█'.repeat(filled)) + theme.muted('░'.repeat(empty));
  const text = label ? `${label} ` : '';
  
  process.stdout.write(`\r  ${text}${bar} ${theme.white(percent + '%')}`);
  
  if (current >= total) {
    process.stdout.write('\n');
  }
}

// ─── 保持向后兼容的导出 ───────────────────────────────────────────────────────

// 为了兼容旧的导入方式，保留原有的函数签名
export const printBannerOld = printBanner;
export const printHelpOld = printHelp;
