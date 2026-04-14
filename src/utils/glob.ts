import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { readFile, readdir, stat } from 'fs/promises'
import ignore from 'ignore'
import { minimatch } from 'minimatch'
import type { ToolPermissionContext } from '../Tool.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'
import {
  canUseRipgrep,
  isRipgrepUnavailableError,
  ripGrep,
} from './ripgrep.js'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --sort=modified: sort by modification time (oldest first)
  // --no-ignore: don't respect .gitignore (default true, set CLAUDE_CODE_GLOB_NO_IGNORE=false to respect .gitignore)
  // --hidden: include hidden files (default true, set CLAUDE_CODE_GLOB_HIDDEN=false to exclude)
  // Note: use || instead of ?? to treat empty string as unset (defaulting to true)
  const noIgnore = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE || 'true')
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')
  const pluginExclusions = await getGlobExclusionsForPluginCache(searchDir)
  const args = [
    '--files',
    '--glob',
    searchPattern,
    '--sort=modified',
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
  ]

  for (const pattern of ignorePatterns) {
    args.push('--glob', `!${pattern}`)
  }
  for (const exclusion of pluginExclusions) {
    args.push('--glob', exclusion)
  }

  const nativeOptions = {
    abortSignal,
    hidden,
    ignorePatterns,
    noIgnore,
    pluginExclusions,
    searchDir,
    searchPattern,
  }

  const allPaths = !(await canUseRipgrep())
    ? await globNative(nativeOptions)
    : await ripGrep(args, searchDir, abortSignal).catch(async error => {
        if (!isRipgrepUnavailableError(error)) {
          throw error
        }
        return globNative(nativeOptions)
      })

  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated }
}

type GlobNativeOptions = {
  abortSignal: AbortSignal
  hidden: boolean
  ignorePatterns: string[]
  noIgnore: boolean
  pluginExclusions: string[]
  searchDir: string
  searchPattern: string
}

type IgnoreMatcher = {
  basePath: string
  matcher: ReturnType<typeof ignore>
}

type NativeMatch = {
  mtimeMs: number
  path: string
}

async function globNative({
  abortSignal,
  hidden,
  ignorePatterns,
  noIgnore,
  pluginExclusions,
  searchDir,
  searchPattern,
}: GlobNativeOptions): Promise<string[]> {
  const directIgnore = ignore()
  const matchBase = !/[\\/]/.test(searchPattern)
  const directPatterns = [
    ...ignorePatterns,
    ...pluginExclusions.map(pattern => pattern.slice(1)),
  ]
  if (directPatterns.length > 0) {
    directIgnore.add(directPatterns)
  }

  const matches: NativeMatch[] = []

  async function walk(
    currentDir: string,
    inheritedIgnoreMatchers: IgnoreMatcher[],
  ): Promise<void> {
    if (abortSignal.aborted) {
      return
    }

    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if (isFsInaccessible(error)) {
        return
      }
      throw error
    }

    const localIgnoreMatchers = noIgnore
      ? inheritedIgnoreMatchers
      : [
          ...inheritedIgnoreMatchers,
          ...(await loadDirectoryIgnoreMatchers(currentDir, searchDir)),
        ]

    for (const entry of entries) {
      if (abortSignal.aborted) {
        return
      }

      if (!hidden && entry.name.startsWith('.')) {
        continue
      }

      const absolutePath = join(currentDir, entry.name)
      const relativePath = relative(searchDir, absolutePath).replace(/\\/g, '/')
      if (!relativePath || relativePath.startsWith('..')) {
        continue
      }

      // Skip symlinks — ripgrep's default does not follow symlinks, and following
      // them risks infinite recursion on circular directory symlinks.
      if (entry.isSymbolicLink()) {
        continue
      }

      const stats = await getEntryStats(absolutePath)
      if (!stats) {
        continue
      }

      const isDirectory = stats.isDirectory()
      const isFile = stats.isFile()
      if (!isDirectory && !isFile) {
        continue
      }

      const candidatePath = isDirectory ? `${relativePath}/` : relativePath
      if (
        directIgnore.ignores(candidatePath) ||
        isIgnoredByMatchers(relativePath, isDirectory, localIgnoreMatchers)
      ) {
        continue
      }

      if (isDirectory) {
        await walk(absolutePath, localIgnoreMatchers)
        continue
      }

      if (
        minimatch(relativePath, searchPattern, {
          dot: hidden,
          matchBase,
          nocase: false,
          windowsPathsNoEscape: true,
        })
      ) {
        matches.push({ mtimeMs: stats.mtimeMs, path: relativePath })
      }
    }
  }

  try {
    const stats = await stat(searchDir)
    if (!stats.isDirectory()) {
      return []
    }
  } catch (error) {
    if (isFsInaccessible(error)) {
      return []
    }
    throw error
  }

  logForDebugging(`[glob] ripgrep unavailable, falling back to native scan: ${searchDir}`)
  await walk(searchDir, [])
  return matches
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
    .map(match => match.path)
}

async function loadDirectoryIgnoreMatchers(
  currentDir: string,
  searchDir: string,
): Promise<IgnoreMatcher[]> {
  const patterns = await Promise.all(
    ['.gitignore', '.ignore', '.rgignore'].map(async name => {
      try {
        return await readFile(join(currentDir, name), 'utf8')
      } catch (error) {
        if (isFsInaccessible(error)) {
          return ''
        }
        throw error
      }
    }),
  )

  const matcher = ignore()
  const combined = patterns.filter(Boolean).join('\n').trim()
  if (!combined) {
    return []
  }

  matcher.add(combined)
  return [
    {
      basePath: relative(searchDir, currentDir).replace(/\\/g, '/'),
      matcher,
    },
  ]
}

function isIgnoredByMatchers(
  relativePath: string,
  isDirectory: boolean,
  matchers: IgnoreMatcher[],
): boolean {
  const candidatePath = isDirectory ? `${relativePath}/` : relativePath

  return matchers.some(({ basePath, matcher }) => {
    const prefix = basePath ? `${basePath}/` : ''
    if (prefix && !candidatePath.startsWith(prefix)) {
      return false
    }

    const scopedPath = prefix ? candidatePath.slice(prefix.length) : candidatePath
    return matcher.ignores(scopedPath)
  })
}

async function getEntryStats(absolutePath: string) {
  try {
    return await stat(absolutePath)
  } catch (error) {
    if (isFsInaccessible(error)) {
      return null
    }
    throw error
  }
}
