/**
 * EnvProbe — System environment sensing tool
 *
 * Inspired by kstack #15370: "让 AI 感知环境并验证结果" (Give AI environmental awareness)
 *
 * The article emphasises that AI wastes most time on the feedback loop:
 * "make change → ask human what happened → adjust". Giving AI direct access
 * to environment state removes human relays in that loop.
 *
 * Four probe sub-commands:
 *   ports     — Which ports are in use? What process owns them?
 *   processes — List running processes (filter by name/pattern)
 *   system    — OS, CPU, memory, disk, Node/Python/Go/Rust versions
 *   deps      — Check versions of project dependencies (from package.json / requirements.txt / Cargo.toml)
 *
 * All probes are read-only. No state is modified.
 *
 * Usage:
 *   EnvProbe probe="ports"                   → show occupied ports
 *   EnvProbe probe="ports" range="3000-9000" → show ports in range
 *   EnvProbe probe="processes" filter="node" → processes matching "node"
 *   EnvProbe probe="system"                  → OS + runtime versions
 *   EnvProbe probe="deps"                    → project dependency versions
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, timeout = 5000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function tryVersion(cmd: string): string {
  const out = run(cmd, 3000);
  return out ? out.split('\n')[0].trim() : 'not installed';
}

// ── Probe: ports ─────────────────────────────────────────────────────────────

function probePorts(rangeStr?: string): string {
  // lsof -iTCP -sTCP:LISTEN -n -P  (macOS + Linux)
  const raw = run('lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null || ss -tlnp 2>/dev/null', 8000);
  if (!raw) return 'Unable to query ports (lsof/ss not available).';

  const lines: string[] = [];
  // Parse lsof output
  for (const line of raw.split('\n')) {
    // lsof line: "node    12345 user   27u  IPv4 ... TCP *:3000 (LISTEN)"
    const m = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(?:TCP\s+)?(?:\S+:)(\d+)\s+\(LISTEN\)/);
    if (m) {
      const [, process, pid, port] = m;
      const portNum = parseInt(port);
      if (rangeStr) {
        const [lo, hi] = rangeStr.split('-').map(Number);
        if (portNum < lo || portNum > (hi || lo)) continue;
      }
      lines.push(`  :${port.padStart(5)}  pid=${pid.padEnd(7)} ${process}`);
    }
  }

  if (lines.length === 0) {
    return rangeStr
      ? `No ports in use in range ${rangeStr}`
      : 'No TCP listening ports found.';
  }

  return [`🔌 Listening Ports${rangeStr ? ` (${rangeStr})` : ''}:`, ...lines].join('\n');
}

// ── Probe: processes ──────────────────────────────────────────────────────────

function probeProcesses(filter?: string): string {
  const isLinux = process.platform === 'linux';
  const psCmd = isLinux
    ? 'ps aux --sort=-%cpu 2>/dev/null'
    : 'ps aux -r 2>/dev/null';

  const raw = run(psCmd, 5000);
  if (!raw) return 'Unable to query processes (ps not available).';

  let lines = raw.split('\n');
  const header = lines[0];
  lines = lines.slice(1);

  if (filter) {
    const lf = filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(lf));
  }

  // Limit to top 30
  lines = lines.slice(0, 30);

  if (lines.length === 0) {
    return filter
      ? `No processes matching "${filter}" found.`
      : 'No processes found.';
  }

  const count = filter ? `(${lines.length} matching "${filter}")` : `(top ${lines.length} by CPU)`;
  return [`🔧 Processes ${count}:`, header, ...lines].join('\n');
}

// ── Probe: system ─────────────────────────────────────────────────────────────

function probeSystem(): string {
  const lines: string[] = ['💻 System Information:\n'];

  // OS
  const platform = process.platform;
  const arch = process.arch;
  const osRelease = run('uname -r 2>/dev/null') || 'unknown';
  lines.push(`  OS:        ${platform} ${arch} (kernel ${osRelease})`);

  // CPU / Memory
  const cpuCount = run('nproc 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null') || '?';
  lines.push(`  CPUs:      ${cpuCount}`);

  // Memory (macOS / Linux)
  const memRaw = run(
    process.platform === 'darwin'
      ? "sysctl -n hw.memsize 2>/dev/null | awk '{printf \"%.1f GB\", $1/1024/1024/1024}'"
      : "grep MemTotal /proc/meminfo 2>/dev/null | awk '{printf \"%.1f GB\", $2/1024/1024}'",
    3000
  );
  if (memRaw) lines.push(`  Memory:    ${memRaw}`);

  // Disk usage (cwd)
  const disk = run('df -h . 2>/dev/null | tail -1', 3000);
  if (disk) {
    const parts = disk.split(/\s+/);
    lines.push(`  Disk (cwd): ${parts[3] || '?'} available of ${parts[1] || '?'}`);
  }

  lines.push('');
  lines.push('📦 Runtime Versions:\n');

  // Runtime versions
  const runtimes = [
    ['Node.js',  `node --version 2>/dev/null`],
    ['npm',      `npm --version 2>/dev/null`],
    ['Python',   `python3 --version 2>/dev/null || python --version 2>/dev/null`],
    ['pip',      `pip3 --version 2>/dev/null | awk '{print $1, $2}' 2>/dev/null`],
    ['Go',       `go version 2>/dev/null | awk '{print $3}'`],
    ['Rust',     `rustc --version 2>/dev/null`],
    ['Java',     `java -version 2>&1 | head -1`],
    ['Docker',   `docker --version 2>/dev/null`],
    ['Git',      `git --version 2>/dev/null`],
    ['bun',      `bun --version 2>/dev/null`],
    ['pnpm',     `pnpm --version 2>/dev/null`],
  ];

  for (const [name, cmd] of runtimes) {
    const ver = tryVersion(cmd);
    if (ver !== 'not installed') {
      lines.push(`  ${name.padEnd(12)} ${ver}`);
    }
  }

  lines.push('');
  lines.push(`  CWD: ${process.cwd()}`);
  lines.push(`  HOME: ${process.env.HOME ?? '?'}`);
  lines.push(`  SHELL: ${process.env.SHELL ?? '?'}`);

  return lines.join('\n');
}

// ── Probe: deps ───────────────────────────────────────────────────────────────

function probeDeps(cwd: string): string {
  const lines: string[] = ['📦 Project Dependencies:\n'];
  let found = false;

  // ── package.json (npm / yarn / pnpm / bun) ──────────────────────────────
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    found = true;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      lines.push(`  📄 package.json — ${pkg.name ?? '(unnamed)'} v${pkg.version ?? '?'}`);

      // Check actual installed versions via node_modules
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      const depCount = Object.keys(allDeps).length;
      lines.push(`  ${depCount} dependencies declared`);

      // Show framework highlights
      const highlights = ['react', 'vue', 'next', 'vite', 'typescript', 'jest', 'vitest', 'express', 'fastify', 'prisma'];
      const present = highlights.filter((h) => allDeps[h]);
      if (present.length > 0) {
        lines.push(`  Key deps: ${present.map((h) => `${h}@${allDeps[h]}`).join(', ')}`);
      }

      // Lock file type
      if (existsSync(join(cwd, 'pnpm-lock.yaml')))   lines.push('  Lock file: pnpm-lock.yaml');
      else if (existsSync(join(cwd, 'yarn.lock')))    lines.push('  Lock file: yarn.lock');
      else if (existsSync(join(cwd, 'bun.lockb')))    lines.push('  Lock file: bun.lockb');
      else if (existsSync(join(cwd, 'package-lock.json'))) lines.push('  Lock file: package-lock.json');
    } catch {
      lines.push('  (Could not parse package.json)');
    }
    lines.push('');
  }

  // ── Cargo.toml (Rust) ────────────────────────────────────────────────────
  const cargoPath = join(cwd, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    found = true;
    try {
      const cargo = readFileSync(cargoPath, 'utf-8');
      const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      const verMatch  = cargo.match(/^version\s*=\s*"([^"]+)"/m);
      lines.push(`  📄 Cargo.toml — ${nameMatch?.[1] ?? '?'} v${verMatch?.[1] ?? '?'}`);

      const depSection = cargo.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
      if (depSection) {
        const deps = depSection[1].match(/^(\w[\w-]+)\s*=/gm) ?? [];
        lines.push(`  ${deps.length} dependencies declared`);
      }
    } catch { /* ignore */ }
    lines.push('');
  }

  // ── requirements.txt (Python) ────────────────────────────────────────────
  const reqPath = join(cwd, 'requirements.txt');
  if (existsSync(reqPath)) {
    found = true;
    const reqs = readFileSync(reqPath, 'utf-8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    lines.push(`  📄 requirements.txt — ${reqs.length} packages`);
    lines.push(`  Packages: ${reqs.slice(0, 8).join(', ')}${reqs.length > 8 ? ` ... +${reqs.length - 8} more` : ''}`);
    lines.push('');
  }

  // ── go.mod (Go) ──────────────────────────────────────────────────────────
  const goModPath = join(cwd, 'go.mod');
  if (existsSync(goModPath)) {
    found = true;
    try {
      const goMod = readFileSync(goModPath, 'utf-8');
      const moduleMatch = goMod.match(/^module\s+(\S+)/m);
      const goVerMatch  = goMod.match(/^go\s+([\d.]+)/m);
      const reqCount = (goMod.match(/^require\s+/gm) ?? []).length +
                       (goMod.match(/\n\t[\w./]+\s+v/g) ?? []).length;
      lines.push(`  📄 go.mod — ${moduleMatch?.[1] ?? '?'} (go ${goVerMatch?.[1] ?? '?'})`);
      lines.push(`  ~${reqCount} dependencies declared`);
    } catch { /* ignore */ }
    lines.push('');
  }

  if (!found) {
    return `No recognizable project manifest found in ${cwd}\n(Looking for: package.json, Cargo.toml, requirements.txt, go.mod)`;
  }

  return lines.join('\n');
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const envProbeTool: ToolRegistration = {
  definition: {
    name: 'EnvProbe',
    description: [
      'Probe the system environment to give AI direct awareness of runtime state.',
      'Inspired by kstack #15370: reduce human relay in the AI feedback loop.',
      '',
      'Probes available:',
      '  ports     — TCP ports currently in use (with owning process)',
      '  processes — Running processes (filter by name)',
      '  system    — OS, CPU, memory, disk, and installed runtime versions (Node, Python, Go, Rust...)',
      '  deps      — Project dependency summary (package.json / Cargo.toml / requirements.txt / go.mod)',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'string',
          enum: ['ports', 'processes', 'system', 'deps'],
          description: 'Which aspect of the environment to probe.',
        },
        filter: {
          type: 'string',
          description: 'For probe="processes": filter by process name. For probe="ports": not used.',
        },
        range: {
          type: 'string',
          description: 'For probe="ports": port range to show, e.g. "3000-9000". Omit for all ports.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for probe="deps". Defaults to current project directory.',
        },
      },
      required: ['probe'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const probe = String(args.probe ?? '').toLowerCase();

    switch (probe) {
      case 'ports':
        return probePorts(args.range ? String(args.range) : undefined);

      case 'processes':
        return probeProcesses(args.filter ? String(args.filter) : undefined);

      case 'system':
        return probeSystem();

      case 'deps': {
        const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();
        return probeDeps(cwd);
      }

      default:
        return `Error: Unknown probe "${probe}". Choose one of: ports, processes, system, deps.`;
    }
  },
};
