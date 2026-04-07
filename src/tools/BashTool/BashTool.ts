/**
 * BashTool/BashTool.ts — Execute shell commands
 *
 * Mirrors claude-code's BashTool.tsx.
 * Includes safe-mode security checks, auto-background for long commands,
 * and large output file storage.
 */

import { existsSync, writeFileSync, mkdtempSync } from 'fs';
import { resolve, join } from 'path';
import { execSync, spawn as spawnProc } from 'child_process';
import { tmpdir } from 'os';
import type { ToolRegistration } from '../../models/types.js';
import { checkExtendedBashSecurity, formatBashSecurityViolations } from '../../utils/bash-security.js';
import { findSuitableShell, buildSubprocessEnv } from '../../utils/shell-provider.js';
import { maybeFireCwdChanged } from '../../core/hooks.js';
import { truncateOutput } from '../shared/fsHelpers.js';

export const bashTool: ToolRegistration = {
  definition: {
    name: 'Bash',
    description: 'Execute a shell command and return the output. Use for running tests, builds, git commands, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (default: current directory)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 1800000 = 30 minutes)' },
      },
      required: ['command'],
    },
  },
  backfillObservableInput(input) {
    if (typeof input['cwd'] === 'string' && !input['cwd'].startsWith('/')) {
      input['cwd'] = resolve(process.cwd(), input['cwd']);
    }
  },
  handler: async (args) => {
    const command = args.command as string;
    const cwd = args.cwd ? resolve(process.cwd(), args.cwd as string) : process.cwd();
    const timeout = (args.timeout as number) || 30 * 60 * 1000;

    const isSafe = process.env.AGENT_SAFE_MODE === '1';
    if (isSafe) {
      // Always-block patterns (catastrophic / unrecoverable)
      const hardBlock = [
        /:\(\)\s*\{\s*:|:\&\s*\}/,
        /:\(\)\{:\|:&\}/,
        />\s*\/dev\/[sh]d[a-z]\d*/,
        />\s*\/dev\/nvme/,
      ];
      for (const pat of hardBlock) {
        if (pat.test(command)) {
          return `Blocked in safe mode: catastrophic command not allowed.\n  Pattern matched: ${pat}`;
        }
      }

      const softBlock: Array<{ pat: RegExp; label: string }> = [
        { pat: /rm\s+-[^\s]*r[^\s]*\s+\/[^\s]*/, label: 'recursive delete from root path' },
        { pat: /rm\s+-rf\s+/,                     label: 'recursive force delete' },
        { pat: /mkfs/,                              label: 'filesystem format' },
        { pat: /dd\s+if=/,                         label: 'raw disk copy (dd)' },
        { pat: /\|\s*(\/\S+\/)?(ba|z|da)?sh\s*$/,  label: 'pipe to shell (code execution)' },
        { pat: /\|\s*(\/\S+\/)?(ba|z|da)?sh\s+-/,  label: 'pipe to shell (code execution)' },
        { pat: /sudo\s+rm\s+-[^\s]*r/,             label: 'sudo recursive delete' },
        { pat: /sudo\s+mkfs/,                       label: 'sudo filesystem format' },
        { pat: /sudo\s+dd\s/,                       label: 'sudo raw disk copy' },
        { pat: />\s*\/(etc|bin|sbin|lib|usr|boot)\/[^\s]*/, label: 'overwrite system file' },
        { pat: /git\s+push\s+.*--force/,            label: 'force git push' },
        { pat: /git\s+push\s+.*-f\b/,              label: 'force git push' },
        { pat: /chmod\s+-R\s+[0-7]*7[0-7]*\s+\//,  label: 'recursive world-writable chmod on root' },
      ];

      function splitCompoundCommand(cmd: string): string[] {
        const atoms = cmd
          .split(/(?:&&|\|\||;|\|(?!>)|\n)/)
          .map((a) => a.trim())
          .filter(Boolean);
        return atoms.length > 1 ? atoms : [cmd];
      }

      const atoms = splitCompoundCommand(command);
      for (const atom of atoms) {
        for (const { pat, label } of softBlock) {
          if (pat.test(atom)) {
            return `__CONFIRM_REQUIRED__:${label} (found in compound command)\n${command}`;
          }
        }
      }
      for (const { pat, label } of softBlock) {
        if (pat.test(command)) {
          return `__CONFIRM_REQUIRED__:${label}\n${command}`;
        }
      }

      const rmPathMatch = command.match(/\brm\s+(?:-\S+\s+)*([~/][\S]*)/);
      if (rmPathMatch) {
        const rmTarget = rmPathMatch[1]!;
        try {
          const { isDangerousRemovalPath } = await import('../../utils/path-security.js');
          if (isDangerousRemovalPath(rmTarget)) {
            return `__CONFIRM_REQUIRED__:dangerous removal target — "${rmTarget}" is a protected system path\n${command}`;
          }
        } catch { /* non-fatal */ }
      }

      const extViolations = checkExtendedBashSecurity(command);
      if (extViolations.length > 0) {
        const hardViolations = extViolations.filter((v) => v.isHard);
        const softViolations = extViolations.filter((v) => !v.isHard);
        if (hardViolations.length > 0) {
          const msgs = formatBashSecurityViolations(hardViolations);
          return `Blocked in safe mode: command failed security checks.\n${msgs}`;
        }
        if (softViolations.length > 0) {
          const msgs = formatBashSecurityViolations(softViolations);
          return `__CONFIRM_REQUIRED__:security warning — ${softViolations[0]!.message}\n${command}\n\nAll warnings:\n${msgs}`;
        }
      }
    }

    if (!existsSync(cwd)) return `Error: Working directory not found: ${cwd}`;

    const shell = findSuitableShell();
    const subprocessEnv = buildSubprocessEnv();

    const BASH_BLOCKING_BUDGET_MS = 15_000;
    const DISALLOWED_AUTO_BACKGROUND = new Set(['sleep', 'wait', 'read', 'pause', 'tail']);
    const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const autoBackgroundEnabled = !DISALLOWED_AUTO_BACKGROUND.has(firstWord) &&
      process.env.BASH_DISABLE_AUTO_BACKGROUND !== '1';

    const startMs = Date.now();

    if (autoBackgroundEnabled) {
      return await new Promise<string>((resolve: (value: string) => void) => {
        const proc = spawnProc(shell ?? 'sh', ['-c', command], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: subprocessEnv,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        let settled = false;

        const autoBackgroundTimer = setTimeout(() => {
          if (settled || proc.exitCode !== null) return;
          settled = true;

          const partialOutput = (stdout + stderr).slice(0, 2000);
          import('../../core/background-manager.js').then(({ backgroundManager: bgMgr }) => {
            const bgId = bgMgr.registerExistingProcess(proc, command, partialOutput);
            resolve(
              `[Command auto-backgrounded after ${BASH_BLOCKING_BUDGET_MS / 1000}s]\n` +
              `Background task ID: ${bgId}\n` +
              `Use check_background { "id": "${bgId}" } to poll for results.\n\n` +
              `Partial output so far (first 2000 chars):\n${partialOutput || '(no output yet)'}`,
            );
          }).catch(() => {
            resolve(`[Command still running after 15s — will complete eventually]\nPartial output:\n${partialOutput.slice(0, 1000)}`);
          });
        }, BASH_BLOCKING_BUDGET_MS);

        const hardTimeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(autoBackgroundTimer);
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
          const raw = (stdout + stderr).trim() || '(no output)';
          resolve(`${raw}\n(Command timed out after ${timeout}ms)`);
        }, timeout);

        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(autoBackgroundTimer);
          clearTimeout(hardTimeoutTimer);

          const elapsed = Date.now() - startMs;
          const raw = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim() || '(no output)';

          const OUTPUT_FILE_THRESHOLD = 100 * 1024;
          if (Buffer.byteLength(raw, 'utf-8') > OUTPUT_FILE_THRESHOLD) {
            try {
              const tmpDir = mkdtempSync(join(tmpdir(), 'uagent-bash-'));
              const outFile = join(tmpDir, 'output.txt');
              writeFileSync(outFile, raw, 'utf-8');
              const lines = raw.split('\n').length;
              const bytes = Buffer.byteLength(raw, 'utf-8');
              const timingNote = elapsed > 5000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : '';
              resolve(
                `Output too large to display inline (${lines} lines, ${Math.round(bytes / 1024)}KB).${timingNote}\n` +
                `Saved to: ${outFile}\n` +
                `Use Read tool to view: Read { file_path: "${outFile}" }\n\n` +
                `Preview (first 100 lines):\n` +
                raw.split('\n').slice(0, 100).join('\n'),
              );
              return;
            } catch { /* fall through to normal truncation */ }
          }

          const { content, truncated } = truncateOutput(raw);
          const timingNote = elapsed > 5000 ? `\n(Completed in ${(elapsed / 1000).toFixed(1)}s)` : '';
          const exitNote = code !== 0 ? `\n(Exit code: ${code})` : '';
          setImmediate(() => { try { maybeFireCwdChanged(process.cwd()); } catch { /* non-fatal */ } });
          resolve(content + timingNote + exitNote + (truncated ? '' : ''));
        });

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(autoBackgroundTimer);
          clearTimeout(hardTimeoutTimer);
          const elapsed = Date.now() - startMs;
          const raw = (stdout + stderr).trim();
          const timingNote = elapsed > 5000 ? `\n(Failed after ${(elapsed / 1000).toFixed(1)}s)` : '';
          resolve(`${raw || 'Command failed'}\n${err.message}${timingNote}`);
        });
      });
    }

    // Non-auto-background path
    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
        env: subprocessEnv,
      });
      const elapsed = Date.now() - startMs;
      const raw = output.trim() || '(no output)';
      const OUTPUT_FILE_THRESHOLD = 100 * 1024;
      if (Buffer.byteLength(raw, 'utf-8') > OUTPUT_FILE_THRESHOLD) {
        try {
          const tmpDir = mkdtempSync(join(tmpdir(), 'uagent-bash-'));
          const outFile = join(tmpDir, 'output.txt');
          writeFileSync(outFile, raw, 'utf-8');
          const lines = raw.split('\n').length;
          const bytes = Buffer.byteLength(raw, 'utf-8');
          const timingNote = elapsed > 5000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : '';
          return (
            `Output too large to display inline (${lines} lines, ${Math.round(bytes / 1024)}KB).${timingNote}\n` +
            `Saved to: ${outFile}\n` +
            `Use Read tool to view: Read { file_path: "${outFile}" }\n\n` +
            `Preview (first 100 lines):\n` +
            raw.split('\n').slice(0, 100).join('\n')
          );
        } catch { /* fall through */ }
      }
      const { content, truncated } = truncateOutput(raw);
      const timingNote = elapsed > 5000 ? `\n(Completed in ${(elapsed / 1000).toFixed(1)}s)` : '';
      setImmediate(() => { try { maybeFireCwdChanged(process.cwd()); } catch { /* non-fatal */ } });
      return content + (truncated ? timingNote : timingNote);
    } catch (err: unknown) {
      const elapsed = Date.now() - startMs;
      const e = err as { stdout?: string; stderr?: string; message?: string; signal?: string };
      const parts: string[] = [];
      if (e.stdout?.trim()) parts.push(e.stdout.trim());
      if (e.stderr?.trim()) parts.push(e.stderr.trim());
      if (!e.stderr && e.message) parts.push(`Exit error: ${e.message}`);
      if (e.signal === 'SIGTERM' || (e.message?.includes('ETIMEDOUT') ?? false)) {
        parts.push(`(Command timed out after ${timeout}ms — use a higher timeout parameter or split into smaller steps)`);
      }
      const rawErr = parts.join('\n') || 'Command failed';
      const { content } = truncateOutput(rawErr);
      const timingNote = elapsed > 5000 ? `\n(Failed after ${(elapsed / 1000).toFixed(1)}s)` : '';
      return content + timingNote;
    }
  },
};
