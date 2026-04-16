// @ts-nocheck
/**
 * src/services/format/index.ts
 *
 * Feature 11: Automatic code formatting after file write/edit.
 *
 * Inspired by opencode's Format service (packages/opencode/src/format/).
 * Detects and runs the appropriate formatter for a file after it's written.
 *
 * Design principles:
 * - Silently no-op if no formatter is found or formatting fails
 * - Use project-local formatter when available (e.g. local prettier)
 * - Lazy detection: cache formatter availability per extension/project
 */

import { execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

type FormatterCommand = {
  command: string
  args: string[]
}

// Cache: "ext|cwd" -> formatter commands or null (false = unavailable)
const formatterCache = new Map<string, FormatterCommand[] | false>()

// Cache: command name -> available (true/false)
const commandExistsCache = new Map<string, boolean>()

/** Find a file by walking up the directory tree */
function findUp(filename: string, startDir: string): string | null {
  let dir = startDir
  const root = dir.split('/').slice(0, 2).join('/') || '/'
  while (dir && dir !== root && dir !== '/') {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Check if a binary exists in PATH (cached) */
function commandExists(cmd: string): boolean {
  const cached = commandExistsCache.get(cmd)
  if (cached !== undefined) return cached

  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 2000 })
    commandExistsCache.set(cmd, true)
    return true
  } catch {
    commandExistsCache.set(cmd, false)
    return false
  }
}

/** Check if package.json contains a dependency */
function hasDep(cwd: string, dep: string): boolean {
  const pkgPath = findUp('package.json', cwd)
  if (!pkgPath) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return !!(
      pkg.dependencies?.[dep] ||
      pkg.devDependencies?.[dep] ||
      pkg.peerDependencies?.[dep]
    )
  } catch {
    return false
  }
}

function prettierCommands(): FormatterCommand[] {
  return [
    {
      command: 'npx',
      args: ['--no-install', 'prettier', '--write', '$FILE'],
    },
    {
      command: 'prettier',
      args: ['--write', '$FILE'],
    },
  ]
}

/** Detect the formatter for a given file path */
function detectFormatter(filePath: string): FormatterCommand[] | false {
  const ext = extname(filePath).toLowerCase()
  const dir = dirname(filePath)
  const cacheKey = `${ext}|${dir}`

  if (formatterCache.has(cacheKey)) {
    return formatterCache.get(cacheKey)!
  }

  let formatter: FormatterCommand[] | false = false

  // JavaScript / TypeScript family
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    // Biome (faster, project-level config)
    if (findUp('biome.json', dir) || findUp('biome.jsonc', dir)) {
      if (commandExists('biome')) {
        formatter = [{ command: 'biome', args: ['format', '--write', '$FILE'] }]
      }
    }
    // Prettier (most common)
    if (!formatter && (hasDep(dir, 'prettier') || commandExists('prettier'))) {
      // Prefer local prettier via npx
      formatter = prettierCommands()
    }
  }

  // JSON / YAML / Markdown / HTML / CSS (also prettier)
  else if (['.json', '.jsonc', '.yaml', '.yml', '.md', '.mdx', '.html', '.css', '.scss', '.less'].includes(ext)) {
    if (hasDep(dir, 'prettier') || commandExists('prettier')) {
      formatter = prettierCommands()
    }
  }

  // Go
  else if (ext === '.go') {
    if (commandExists('gofmt')) {
      formatter = [{ command: 'gofmt', args: ['-w', '$FILE'] }]
    }
  }

  // Rust
  else if (ext === '.rs') {
    if (commandExists('rustfmt')) {
      formatter = [{ command: 'rustfmt', args: ['$FILE'] }]
    }
  }

  // Python (ruff preferred over black/autopep8)
  else if (ext === '.py' || ext === '.pyw') {
    if (commandExists('ruff')) {
      formatter = [{ command: 'ruff', args: ['format', '$FILE'] }]
    } else if (commandExists('black')) {
      formatter = [{ command: 'black', args: ['$FILE'] }]
    }
  }

  // Elixir
  else if (['.ex', '.exs', '.heex', '.leex'].includes(ext)) {
    if (commandExists('mix')) {
      formatter = [{ command: 'mix', args: ['format', '$FILE'] }]
    }
  }

  // Ruby
  else if (ext === '.rb') {
    if (commandExists('standardrb')) {
      formatter = [{ command: 'standardrb', args: ['--fix', '$FILE'] }]
    } else if (commandExists('rubocop')) {
      formatter = [{ command: 'rubocop', args: ['-a', '$FILE'] }]
    }
  }

  // Zig
  else if (ext === '.zig') {
    if (commandExists('zig')) {
      formatter = [{ command: 'zig', args: ['fmt', '$FILE'] }]
    }
  }

  // C / C++
  else if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(ext)) {
    if (findUp('.clang-format', dir) && commandExists('clang-format')) {
      formatter = [{ command: 'clang-format', args: ['-i', '$FILE'] }]
    }
  }

  // Terraform
  else if (ext === '.tf' || ext === '.tfvars') {
    if (commandExists('terraform')) {
      formatter = [{ command: 'terraform', args: ['fmt', '$FILE'] }]
    }
  }

  // Shell
  else if (['.sh', '.bash', '.zsh'].includes(ext)) {
    if (commandExists('shfmt')) {
      formatter = [{ command: 'shfmt', args: ['-w', '$FILE'] }]
    }
  }

  // Dart
  else if (ext === '.dart') {
    if (commandExists('dart')) {
      formatter = [{ command: 'dart', args: ['format', '$FILE'] }]
    }
  }

  // Kotlin
  else if (ext === '.kt' || ext === '.kts') {
    if (commandExists('ktlint')) {
      formatter = [{ command: 'ktlint', args: ['--format', '$FILE'] }]
    }
  }

  // Nix (nixfmt)
  else if (ext === '.nix') {
    if (commandExists('nixfmt')) {
      formatter = [{ command: 'nixfmt', args: ['$FILE'] }]
    }
  }

  // Gleam
  else if (ext === '.gleam') {
    if (commandExists('gleam')) {
      formatter = [{ command: 'gleam', args: ['format', '$FILE'] }]
    }
  }

  // OCaml (ocamlformat)
  else if (ext === '.ml' || ext === '.mli') {
    if (commandExists('ocamlformat')) {
      formatter = [{ command: 'ocamlformat', args: ['-i', '$FILE'] }]
    }
  }

  // Haskell (ormolu preferred, then fourmolu)
  else if (ext === '.hs' || ext === '.lhs') {
    if (commandExists('ormolu')) {
      formatter = [{ command: 'ormolu', args: ['-i', '$FILE'] }]
    } else if (commandExists('fourmolu')) {
      formatter = [{ command: 'fourmolu', args: ['-i', '$FILE'] }]
    } else if (commandExists('hindent')) {
      formatter = [{ command: 'hindent', args: ['$FILE'] }]
    }
  }

  // PHP (pint)
  else if (ext === '.php') {
    // Laravel Pint (project-local)
    const pintBin = join(dir, 'vendor', 'bin', 'pint')
    if (existsSync(pintBin)) {
      formatter = [{ command: pintBin, args: ['$FILE'] }]
    } else if (commandExists('pint')) {
      formatter = [{ command: 'pint', args: ['$FILE'] }]
    }
  }

  // Swift (swift-format)
  else if (ext === '.swift') {
    if (commandExists('swift-format')) {
      formatter = [{ command: 'swift-format', args: ['-i', '$FILE'] }]
    } else if (commandExists('swiftformat')) {
      formatter = [{ command: 'swiftformat', args: ['$FILE'] }]
    }
  }

  // Scala (scalafmt)
  else if (ext === '.scala' || ext === '.sbt' || ext === '.sc') {
    if (commandExists('scalafmt')) {
      formatter = [{ command: 'scalafmt', args: ['$FILE'] }]
    }
  }

  // Lua (stylua)
  else if (ext === '.lua') {
    if (commandExists('stylua')) {
      formatter = [{ command: 'stylua', args: ['$FILE'] }]
    }
  }

  // TOML (taplo)
  else if (ext === '.toml') {
    if (commandExists('taplo')) {
      formatter = [{ command: 'taplo', args: ['format', '$FILE'] }]
    }
  }

  // SQL (pg_format or sqlfluff)
  else if (ext === '.sql') {
    if (commandExists('pg_format')) {
      formatter = [{ command: 'pg_format', args: ['-i', '$FILE'] }]
    } else if (commandExists('sqlfluff')) {
      formatter = [{ command: 'sqlfluff', args: ['format', '$FILE'] }]
    }
  }

  // Zig (also .zon files)
  else if (ext === '.zon') {
    if (commandExists('zig')) {
      formatter = [{ command: 'zig', args: ['fmt', '$FILE'] }]
    }
  }

  formatterCache.set(cacheKey, formatter)
  return formatter
}

/**
 * Format a file using the appropriate formatter.
 * Silently no-ops if no formatter is detected or formatting fails.
 *
 * @param filePath Absolute path to the file to format
 * @param timeoutMs Maximum time to wait for formatter (default: 8 seconds)
 */
async function runFormatter(
  formatter: FormatterCommand,
  filePath: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const args = formatter.args.map(arg =>
      arg === '$FILE' ? filePath : arg,
    )
    await execFileAsync(formatter.command, args, {
      timeout: timeoutMs,
      cwd: dirname(filePath),
    })
    return true
  } catch {
    return false
  }
}

export async function formatFile(filePath: string, timeoutMs = 8000): Promise<void> {
  try {
    const formatter = detectFormatter(filePath)
    if (!formatter) return

    for (const candidate of formatter) {
      if (await runFormatter(candidate, filePath, timeoutMs)) {
        return
      }
    }
  } catch {
    // Silently ignore all formatting errors — formatting is best-effort
  }
}

/**
 * Clear the formatter detection cache (useful for testing or after config changes)
 */
export function clearFormatterCache(): void {
  formatterCache.clear()
  commandExistsCache.clear()
}
