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

// Cache: "ext|cwd" -> formatter command or null (false = unavailable)
const formatterCache = new Map<string, string | false>()

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

/** Check if a binary exists in PATH */
function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
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

/** Detect the formatter for a given file path */
function detectFormatter(filePath: string): string | false {
  const ext = extname(filePath).toLowerCase()
  const dir = dirname(filePath)
  const cacheKey = `${ext}|${dir}`

  if (formatterCache.has(cacheKey)) {
    return formatterCache.get(cacheKey)!
  }

  let formatter: string | false = false

  // JavaScript / TypeScript family
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    // Biome (faster, project-level config)
    if (findUp('biome.json', dir) || findUp('biome.jsonc', dir)) {
      if (commandExists('biome')) {
        formatter = 'biome format --write $FILE'
      }
    }
    // Prettier (most common)
    if (!formatter && (hasDep(dir, 'prettier') || commandExists('prettier'))) {
      // Prefer local prettier via npx
      formatter = 'npx --no-install prettier --write $FILE 2>/dev/null || prettier --write $FILE'
    }
  }

  // JSON / YAML / Markdown / HTML / CSS (also prettier)
  else if (['.json', '.jsonc', '.yaml', '.yml', '.md', '.mdx', '.html', '.css', '.scss', '.less'].includes(ext)) {
    if (hasDep(dir, 'prettier') || commandExists('prettier')) {
      formatter = 'npx --no-install prettier --write $FILE 2>/dev/null || prettier --write $FILE'
    }
  }

  // Go
  else if (ext === '.go') {
    if (commandExists('gofmt')) {
      formatter = 'gofmt -w $FILE'
    }
  }

  // Rust
  else if (ext === '.rs') {
    if (commandExists('rustfmt')) {
      formatter = 'rustfmt $FILE'
    }
  }

  // Python (ruff preferred over black/autopep8)
  else if (ext === '.py' || ext === '.pyw') {
    if (commandExists('ruff')) {
      formatter = 'ruff format $FILE'
    } else if (commandExists('black')) {
      formatter = 'black $FILE'
    }
  }

  // Elixir
  else if (['.ex', '.exs', '.heex', '.leex'].includes(ext)) {
    if (commandExists('mix')) {
      formatter = 'mix format $FILE'
    }
  }

  // Ruby
  else if (ext === '.rb') {
    if (commandExists('standardrb')) {
      formatter = 'standardrb --fix $FILE'
    } else if (commandExists('rubocop')) {
      formatter = 'rubocop -a $FILE'
    }
  }

  // Zig
  else if (ext === '.zig') {
    if (commandExists('zig')) {
      formatter = 'zig fmt $FILE'
    }
  }

  // C / C++
  else if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(ext)) {
    if (findUp('.clang-format', dir) && commandExists('clang-format')) {
      formatter = 'clang-format -i $FILE'
    }
  }

  // Terraform
  else if (ext === '.tf' || ext === '.tfvars') {
    if (commandExists('terraform')) {
      formatter = 'terraform fmt $FILE'
    }
  }

  // Shell
  else if (['.sh', '.bash', '.zsh'].includes(ext)) {
    if (commandExists('shfmt')) {
      formatter = 'shfmt -w $FILE'
    }
  }

  // Dart
  else if (ext === '.dart') {
    if (commandExists('dart')) {
      formatter = 'dart format $FILE'
    }
  }

  // Kotlin
  else if (ext === '.kt' || ext === '.kts') {
    if (commandExists('ktlint')) {
      formatter = 'ktlint --format $FILE'
    }
  }

  // Nix (nixfmt)
  else if (ext === '.nix') {
    if (commandExists('nixfmt')) {
      formatter = 'nixfmt $FILE'
    }
  }

  // Gleam
  else if (ext === '.gleam') {
    if (commandExists('gleam')) {
      formatter = 'gleam format $FILE'
    }
  }

  // OCaml (ocamlformat)
  else if (ext === '.ml' || ext === '.mli') {
    if (commandExists('ocamlformat')) {
      formatter = 'ocamlformat -i $FILE'
    }
  }

  // Haskell (ormolu preferred, then fourmolu)
  else if (ext === '.hs' || ext === '.lhs') {
    if (commandExists('ormolu')) {
      formatter = 'ormolu -i $FILE'
    } else if (commandExists('fourmolu')) {
      formatter = 'fourmolu -i $FILE'
    } else if (commandExists('hindent')) {
      formatter = 'hindent $FILE'
    }
  }

  // PHP (pint)
  else if (ext === '.php') {
    // Laravel Pint (project-local)
    const pintBin = join(dir, 'vendor', 'bin', 'pint')
    if (existsSync(pintBin)) {
      formatter = `${pintBin} $FILE`
    } else if (commandExists('pint')) {
      formatter = 'pint $FILE'
    }
  }

  // Swift (swift-format)
  else if (ext === '.swift') {
    if (commandExists('swift-format')) {
      formatter = 'swift-format -i $FILE'
    } else if (commandExists('swiftformat')) {
      formatter = 'swiftformat $FILE'
    }
  }

  // Scala (scalafmt)
  else if (ext === '.scala' || ext === '.sbt' || ext === '.sc') {
    if (commandExists('scalafmt')) {
      formatter = 'scalafmt $FILE'
    }
  }

  // Lua (stylua)
  else if (ext === '.lua') {
    if (commandExists('stylua')) {
      formatter = 'stylua $FILE'
    }
  }

  // TOML (taplo)
  else if (ext === '.toml') {
    if (commandExists('taplo')) {
      formatter = 'taplo format $FILE'
    }
  }

  // SQL (pg_format or sqlfluff)
  else if (ext === '.sql') {
    if (commandExists('pg_format')) {
      formatter = 'pg_format -i $FILE'
    } else if (commandExists('sqlfluff')) {
      formatter = 'sqlfluff format $FILE'
    }
  }

  // Zig (also .zon files)
  else if (ext === '.zon') {
    if (commandExists('zig')) {
      formatter = 'zig fmt $FILE'
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
export async function formatFile(filePath: string, timeoutMs = 8000): Promise<void> {
  try {
    const formatter = detectFormatter(filePath)
    if (!formatter) return

    // Replace $FILE placeholder with the actual path (quoted for safety)
    const command = formatter.replace('$FILE', `"${filePath.replace(/"/g, '\\"')}"`)

    await execFileAsync('/bin/sh', ['-c', command], {
      timeout: timeoutMs,
      cwd: dirname(filePath),
    })
  } catch {
    // Silently ignore all formatting errors — formatting is best-effort
  }
}

/**
 * Clear the formatter detection cache (useful for testing or after config changes)
 */
export function clearFormatterCache(): void {
  formatterCache.clear()
}
