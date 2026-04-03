/**
 * Terminal IPC Tools — borrow user's existing terminal sessions for remote access
 *
 * Inspired by kstack article #15377: "让 Agent 访问远程环境的最简方案：终端 IPC"
 *
 * Core idea: Instead of the agent opening new SSH connections (which requires keys,
 * bastion hosts, and MFA), it "types" into and "reads" from terminal panes that the
 * user already has open and authenticated.
 *
 * Supported backends (auto-detected, priority order):
 *   1. WezTerm  — `wezterm cli` (best support, cross-platform)
 *   2. tmux     — `tmux send-keys` / `capture-pane` (most universal)
 *   3. Kitty    — `kitty @` (requires allow_remote_control yes in kitty.conf)
 *   4. iTerm2   — AppleScript (macOS only)
 *
 * Three tools:
 *   TerminalSend  — inject a command into a pane (fire-and-forget)
 *   TerminalRead  — capture current screen content of a pane
 *   TerminalExec  — send command + wait for marker + return output (recommended)
 *
 * Marker pattern (solves timing uncertainty):
 *   TerminalExec appends `; echo "TIPC_DONE_<uuid>"` to the command,
 *   then polls TerminalRead until the marker appears in output.
 *   This is far more reliable than sleeping a fixed number of seconds.
 *
 * Usage examples:
 *   TerminalExec pane=0 command="free -h"              → memory info from remote
 *   TerminalExec pane=k8s command="kubectl get pods"   → k8s status
 *   TerminalRead pane=0 lines=50                       → raw screen content
 *   TerminalSend pane=0 command="tail -f app.log"      → start tail (no wait)
 *
 * Security note:
 *   This tool can execute arbitrary commands in any open terminal session.
 *   In safe mode (AGENT_SAFE_MODE=1), TerminalExec requires user confirmation
 *   for commands that look dangerous (rm, kill, sudo, etc.).
 */

import { execSync, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import type { ToolRegistration } from '../../../models/types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('terminal-ipc');

// ── Backend Detection ─────────────────────────────────────────────────────────

type TerminalBackend = 'wezterm' | 'tmux' | 'kitty' | 'iterm2' | 'none';

let _detectedBackend: TerminalBackend | null = null;

function detectBackend(): TerminalBackend {
  if (_detectedBackend) return _detectedBackend;

  // Allow explicit override
  const override = process.env.TERMINAL_IPC_BACKEND;
  if (override && ['wezterm', 'tmux', 'kitty', 'iterm2'].includes(override)) {
    _detectedBackend = override as TerminalBackend;
    log.info(`Terminal IPC backend: ${_detectedBackend} (from env override)`);
    return _detectedBackend;
  }

  // WezTerm: check if wezterm CLI is available and responsive
  try {
    execSync('wezterm cli list --format json', { timeout: 2000, stdio: 'pipe' });
    _detectedBackend = 'wezterm';
    log.info('Terminal IPC backend: wezterm');
    return _detectedBackend;
  } catch { /* not available */ }

  // tmux: check if we're inside a tmux session
  try {
    execSync('tmux list-panes', { timeout: 2000, stdio: 'pipe' });
    _detectedBackend = 'tmux';
    log.info('Terminal IPC backend: tmux');
    return _detectedBackend;
  } catch { /* not available */ }

  // Kitty: check if kitty remote control is available
  try {
    execSync('kitty @ ls', { timeout: 2000, stdio: 'pipe' });
    _detectedBackend = 'kitty';
    log.info('Terminal IPC backend: kitty');
    return _detectedBackend;
  } catch { /* not available */ }

  // iTerm2: macOS only, check if iTerm2 is running
  if (process.platform === 'darwin') {
    try {
      const result = execSync(
        'osascript -e \'tell application "System Events" to (name of processes) contains "iTerm2"\'',
        { timeout: 2000, stdio: 'pipe' },
      ).toString().trim();
      if (result === 'true') {
        _detectedBackend = 'iterm2';
        log.info('Terminal IPC backend: iTerm2');
        return _detectedBackend;
      }
    } catch { /* not available */ }
  }

  _detectedBackend = 'none';
  log.warn('Terminal IPC: no supported backend detected (wezterm/tmux/kitty/iTerm2)');
  return _detectedBackend;
}

/** Force re-detection (useful after TERMINAL_IPC_BACKEND env var changes) */
export function resetTerminalBackend(): void {
  _detectedBackend = null;
}

// ── Pane Resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a user-friendly pane name to the backend-specific identifier.
 *
 * Supported formats:
 *   "0"          → pane index 0 (backend-specific meaning)
 *   "1"          → pane index 1
 *   "k8s"        → tmux pane/window named "k8s"
 *   (empty)      → current/active pane
 */
function resolvePaneId(pane: string | undefined, backend: TerminalBackend): string {
  if (!pane || pane === 'current' || pane === '') {
    switch (backend) {
      case 'wezterm': return ''; // empty = active pane
      case 'tmux':    return '';  // empty = current pane
      case 'kitty':   return '';
      case 'iterm2':  return '';
      default:        return '';
    }
  }
  return pane;
}

// ── Backend Implementations ───────────────────────────────────────────────────

/** Send text/command to a pane (fire-and-forget, no output capture) */
async function backendSend(
  backend: TerminalBackend,
  pane: string,
  text: string,
): Promise<void> {
  const p = resolvePaneId(pane, backend);

  switch (backend) {
    case 'wezterm': {
      const args = ['cli', 'send-text'];
      if (p) args.push('--pane-id', p);
      args.push('--no-paste', text + '\n');
      execFileSync('wezterm', args, { timeout: 5000, stdio: 'pipe' });
      break;
    }

    case 'tmux': {
      // tmux send-keys sends keystrokes; use -l (literal) to avoid special char interpretation
      const target = p ? `-t ${p}` : '';
      execSync(`tmux send-keys ${target} -l ${JSON.stringify(text)} Enter`, {
        timeout: 5000, stdio: 'pipe',
      });
      break;
    }

    case 'kitty': {
      const args = ['@', 'send-text'];
      if (p) args.push('--match', `id:${p}`);
      args.push(text + '\n');
      execFileSync('kitty', args, { timeout: 5000, stdio: 'pipe' });
      break;
    }

    case 'iterm2': {
      // AppleScript: write text to current session
      const script = `tell application "iTerm2"
  tell current window
    tell current session
      write text "${text.replace(/"/g, '\\"')}"
    end tell
  end tell
end tell`;
      execSync(`osascript -e ${JSON.stringify(script)}`, { timeout: 5000, stdio: 'pipe' });
      break;
    }

    default:
      throw new Error('No terminal IPC backend available. Install WezTerm, tmux, or Kitty.');
  }
}

/** Read current screen content from a pane */
async function backendRead(
  backend: TerminalBackend,
  pane: string,
  lines: number,
): Promise<string> {
  const p = resolvePaneId(pane, backend);

  switch (backend) {
    case 'wezterm': {
      const args = ['cli', 'get-text'];
      if (p) args.push('--pane-id', p);
      args.push('--escapes', '--start-line', String(-lines));
      const out = execFileSync('wezterm', args, { timeout: 5000, stdio: 'pipe' });
      return out.toString();
    }

    case 'tmux': {
      const target = p ? `-t ${p}` : '';
      // capture-pane -p: print to stdout; -S -N: capture last N lines
      const out = execSync(
        `tmux capture-pane ${target} -p -S -${lines}`,
        { timeout: 5000, stdio: 'pipe' },
      );
      return out.toString();
    }

    case 'kitty': {
      const args = ['@', 'get-text', '--extent', 'screen'];
      if (p) args.push('--match', `id:${p}`);
      const out = execFileSync('kitty', args, { timeout: 5000, stdio: 'pipe' });
      // Return last `lines` lines
      return out.toString().split('\n').slice(-lines).join('\n');
    }

    case 'iterm2': {
      // AppleScript: get visible text of current session
      const script = `tell application "iTerm2"
  tell current window
    tell current session
      get contents
    end tell
  end tell
end tell`;
      const out = execSync(`osascript -e ${JSON.stringify(script)}`, {
        timeout: 5000, stdio: 'pipe',
      });
      const text = out.toString();
      return text.split('\n').slice(-lines).join('\n');
    }

    default:
      throw new Error('No terminal IPC backend available.');
  }
}

// ── Marker-based Execution ────────────────────────────────────────────────────

/**
 * Send a command to a pane and wait until its output appears (marker pattern).
 *
 * Algorithm (from kstack #15377):
 *   1. Generate unique marker: TIPC_DONE_<random>
 *   2. Append `; echo "<marker>"` to the command
 *   3. Send the combined command to the pane
 *   4. Poll screen content every 500ms until marker appears or timeout
 *   5. Return everything between the command echo and the marker
 *
 * This is much more reliable than sleep-based waiting because:
 *   - Fast commands finish in <100ms, slow ones may take 30s+
 *   - The marker is unique so we can't false-positive on previous output
 */
async function markerExec(
  backend: TerminalBackend,
  pane: string,
  command: string,
  timeoutMs: number,
  captureLines: number,
): Promise<string> {
  const marker = `TIPC_DONE_${randomBytes(6).toString('hex')}`;
  const combined = `${command}; echo "${marker}"`;

  // Send the command
  await backendSend(backend, pane, combined);

  // Poll until marker appears
  const pollIntervalMs = 500;
  const deadline = Date.now() + timeoutMs;
  let lastContent = '';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const content = await backendRead(backend, pane, captureLines);
      lastContent = content;
      if (content.includes(marker)) {
        // Extract output: everything after the command line, before the marker
        const lines = content.split('\n');
        const markerLine = lines.findIndex((l) => l.includes(marker));
        // Find where the command was echoed (look backwards from marker)
        const commandEchoLine = Math.max(
          0,
          lines.findIndex((l) => l.includes(combined.slice(0, 30))) + 1,
        );
        const outputLines = lines.slice(commandEchoLine, markerLine);
        return outputLines.join('\n').trim();
      }
    } catch (err) {
      // Temporary read failure — keep polling
      log.debug(`Terminal read error (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Timeout — return whatever we have (partial output)
  return `[TIMEOUT after ${timeoutMs / 1000}s — partial output]\n${lastContent}`;
}

// ── Dangerous Command Detection ───────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bkill\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\btruncate\b/,
  />\s*\/dev\//,
  /\bpkill\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

// ── Tool: TerminalSend ────────────────────────────────────────────────────────

export const terminalSendTool: ToolRegistration = {
  definition: {
    name: 'TerminalSend',
    description:
      'Send a command to an open terminal pane (fire-and-forget, no output capture). ' +
      'Use TerminalExec instead when you need to capture the command output. ' +
      'Useful for starting long-running processes like `tail -f` or starting a server. ' +
      'Requires WezTerm, tmux, Kitty, or iTerm2 to be running.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to send to the terminal pane',
        },
        pane: {
          type: 'string',
          description:
            'Pane identifier. For WezTerm: numeric pane ID (from `wezterm cli list`). ' +
            'For tmux: target like "0", "1", or "session:window.pane". ' +
            'For Kitty: numeric window ID. ' +
            'Omit or use "current" to target the active pane.',
        },
      },
      required: ['command'],
    },
  },

  handler: async (args) => {
    const command = args.command as string;
    const pane = (args.pane as string | undefined) ?? '';

    const backend = detectBackend();
    if (backend === 'none') {
      return (
        '❌ No terminal IPC backend found.\n' +
        'Install one of: WezTerm, tmux, Kitty, or iTerm2.\n' +
        'Then restart and try again.'
      );
    }

    // Safe mode: block dangerous commands
    if (process.env.AGENT_SAFE_MODE === '1' && isDangerous(command)) {
      return (
        `⚠️  BLOCKED (safe mode): Potentially dangerous command detected.\n` +
        `  Command: ${command}\n` +
        `  Disable safe mode or run manually in the terminal.`
      );
    }

    try {
      await backendSend(backend, pane, command);
      const paneDesc = pane ? `pane ${pane}` : 'active pane';
      return `✓ Sent to ${paneDesc} via ${backend}: ${command.slice(0, 100)}${command.length > 100 ? '…' : ''}`;
    } catch (err) {
      return `❌ TerminalSend failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Tool: TerminalRead ────────────────────────────────────────────────────────

export const terminalReadTool: ToolRegistration = {
  definition: {
    name: 'TerminalRead',
    description:
      'Read the current screen content of an open terminal pane. ' +
      'Returns the last N lines visible in the pane buffer. ' +
      'Useful for checking the current state of a running process, ' +
      'or reading output from a previously sent command. ' +
      'Requires WezTerm, tmux, Kitty, or iTerm2.',
    parameters: {
      type: 'object',
      properties: {
        pane: {
          type: 'string',
          description:
            'Pane identifier (same format as TerminalSend). ' +
            'Omit for the active pane.',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to capture from the bottom of the screen (default: 100)',
        },
      },
      required: [],
    },
  },

  handler: async (args) => {
    const pane = (args.pane as string | undefined) ?? '';
    const lines = Math.min((args.lines as number | undefined) ?? 100, 500);

    const backend = detectBackend();
    if (backend === 'none') {
      return '❌ No terminal IPC backend found. Install WezTerm, tmux, Kitty, or iTerm2.';
    }

    try {
      const content = await backendRead(backend, pane, lines);
      const paneDesc = pane ? `pane ${pane}` : 'active pane';
      const lineCount = content.split('\n').length;
      return (
        `[Terminal content — ${paneDesc} via ${backend} — ${lineCount} lines]\n` +
        '```\n' +
        content +
        '\n```'
      );
    } catch (err) {
      return `❌ TerminalRead failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Tool: TerminalExec ────────────────────────────────────────────────────────

export const terminalExecTool: ToolRegistration = {
  definition: {
    name: 'TerminalExec',
    description:
      'Execute a command in an open terminal pane and capture its output. ' +
      'Uses the marker pattern (appends a unique sentinel to the command) to reliably ' +
      'detect command completion — much more robust than sleep-based waiting. ' +
      'This is the recommended way to run commands and get their output from remote sessions. ' +
      '\n\nExamples:\n' +
      '  - Check memory: TerminalExec pane=0 command="free -h"\n' +
      '  - K8s pods: TerminalExec pane=k8s command="kubectl get pods -n prod"\n' +
      '  - Recent logs: TerminalExec pane=0 command="journalctl -n 50 --no-pager"\n' +
      'Requires WezTerm, tmux, Kitty, or iTerm2.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute in the terminal pane',
        },
        pane: {
          type: 'string',
          description:
            'Pane identifier. For WezTerm: numeric pane ID. ' +
            'For tmux: target like "0", "session:window.pane", or a named window. ' +
            'Omit for active pane.',
        },
        timeout: {
          type: 'number',
          description:
            'Maximum time to wait for command completion in seconds (default: 30, max: 300)',
        },
        capture_lines: {
          type: 'number',
          description: 'Number of screen lines to capture when reading output (default: 200)',
        },
      },
      required: ['command'],
    },
  },

  handler: async (args) => {
    const command = args.command as string;
    const pane = (args.pane as string | undefined) ?? '';
    const timeoutSec = Math.min((args.timeout as number | undefined) ?? 30, 300);
    const captureLines = Math.min((args.capture_lines as number | undefined) ?? 200, 500);

    const backend = detectBackend();
    if (backend === 'none') {
      return (
        '❌ No terminal IPC backend found.\n' +
        'Please install WezTerm (recommended), tmux, Kitty, or iTerm2.\n\n' +
        'Quick setup:\n' +
        '  • WezTerm: https://wezfurlong.org/wezterm/\n' +
        '  • tmux: brew install tmux && tmux new -s main\n' +
        '  • Kitty: add `allow_remote_control yes` to ~/.config/kitty/kitty.conf'
      );
    }

    // Safe mode: block dangerous commands
    if (process.env.AGENT_SAFE_MODE === '1' && isDangerous(command)) {
      return (
        `⚠️  BLOCKED (safe mode): Potentially dangerous command detected.\n` +
        `  Command: ${command}\n` +
        `  Disable safe mode (unset AGENT_SAFE_MODE) or run manually.`
      );
    }

    const paneDesc = pane ? `pane ${pane}` : 'active pane';
    log.info(`TerminalExec [${backend}] ${paneDesc}: ${command.slice(0, 80)}`);

    try {
      const output = await markerExec(
        backend,
        pane,
        command,
        timeoutSec * 1000,
        captureLines,
      );

      if (!output) {
        return `[No output captured from ${paneDesc}. Command may have produced no stdout.]`;
      }

      return (
        `[TerminalExec — ${paneDesc} via ${backend}]\n` +
        `$ ${command}\n` +
        '```\n' +
        output +
        '\n```'
      );
    } catch (err) {
      return `❌ TerminalExec failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Tool: TerminalList ────────────────────────────────────────────────────────

export const terminalListTool: ToolRegistration = {
  definition: {
    name: 'TerminalList',
    description:
      'List all available terminal panes/sessions that the agent can interact with. ' +
      'Use this to discover pane IDs before calling TerminalSend/TerminalRead/TerminalExec.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  handler: async () => {
    const backend = detectBackend();

    if (backend === 'none') {
      return (
        '❌ No terminal IPC backend found.\n' +
        'Supported backends: WezTerm, tmux, Kitty, iTerm2.\n' +
        'Set TERMINAL_IPC_BACKEND=wezterm|tmux|kitty|iterm2 to force a backend.'
      );
    }

    try {
      let listing = '';
      switch (backend) {
        case 'wezterm': {
          const out = execSync('wezterm cli list --format json', {
            timeout: 5000, stdio: 'pipe',
          }).toString();
          const panes = JSON.parse(out) as Array<{
            pane_id: number;
            title: string;
            cwd: string;
            is_active: boolean;
          }>;
          listing = panes.map((p) =>
            `  Pane ${p.pane_id}${p.is_active ? ' (active)' : ''}: ${p.title} — ${p.cwd}`
          ).join('\n');
          break;
        }

        case 'tmux': {
          const out = execSync(
            'tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path}"',
            { timeout: 5000, stdio: 'pipe' },
          ).toString();
          listing = out.trim().split('\n').map((l) => `  ${l}`).join('\n');
          break;
        }

        case 'kitty': {
          const out = execSync('kitty @ ls', { timeout: 5000, stdio: 'pipe' }).toString();
          const data = JSON.parse(out) as Array<{ id: number; title: string }>;
          listing = data.map((w) => `  Window ${w.id}: ${w.title}`).join('\n');
          break;
        }

        case 'iterm2': {
          listing = '  Use TerminalExec without a pane ID to target the current iTerm2 session.';
          break;
        }
      }

      return (
        `Terminal IPC backend: ${backend}\n\nAvailable panes:\n${listing || '  (none found)'}\n\n` +
        `Use the pane identifier above as the "pane" parameter in TerminalSend/TerminalRead/TerminalExec.`
      );
    } catch (err) {
      return `❌ TerminalList failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
