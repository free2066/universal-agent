import { platform } from 'os'
import { join } from 'path'
import { HOME_DIR } from './env.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import type { IdeType } from './ide.js'

const PLUGIN_PREFIX = 'claude-code-jetbrains-plugin'

// Map of IDE names to their directory patterns
const ideNameToDirMap: { [key: string]: string[] } = {
  pycharm: ['PyCharm'],
  intellij: ['IntelliJIdea', 'IdeaIC'],
  webstorm: ['WebStorm'],
  phpstorm: ['PhpStorm'],
  rubymine: ['RubyMine'],
  clion: ['CLion'],
  goland: ['GoLand'],
  rider: ['Rider'],
  datagrip: ['DataGrip'],
  appcode: ['AppCode'],
  dataspell: ['DataSpell'],
  aqua: ['Aqua'],
  gateway: ['Gateway'],
  fleet: ['Fleet'],
  androidstudio: ['AndroidStudio'],
}

// ============================================================================
// Precompiled regex cache for IDE patterns (performance optimization)
// ============================================================================
const IDE_PATTERN_REGEX_CACHE = new Map<string, RegExp[]>()
function getIdePatternRegexes(ideName: string): RegExp[] {
  let regexes = IDE_PATTERN_REGEX_CACHE.get(ideName)
  if (!regexes) {
    const ideNameLower = ideName.toLowerCase()
    const patterns = ideNameToDirMap[ideNameLower]
    regexes = patterns?.map(p => new RegExp('^' + p)) ?? []
    IDE_PATTERN_REGEX_CACHE.set(ideName, regexes)
  }
  return regexes
}

// Build plugin directory paths
// https://www.jetbrains.com/help/pycharm/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html#plugins-directory
function buildCommonPluginDirectoryPaths(ideName: string): string[] {
  const directories: string[] = []
  const ideNameLower = ideName.toLowerCase()
  const idePatterns = ideNameToDirMap[ideNameLower]
  if (!idePatterns) {
    return directories
  }

  const appData = process.env.APPDATA || join(HOME_DIR, 'AppData', 'Roaming')
  const localAppData =
    process.env.LOCALAPPDATA || join(HOME_DIR, 'AppData', 'Local')

  switch (platform()) {
    case 'darwin':
      directories.push(
        join(HOME_DIR, 'Library', 'Application Support', 'JetBrains'),
        join(HOME_DIR, 'Library', 'Application Support'),
      )
      if (ideNameLower === 'androidstudio') {
        directories.push(
          join(HOME_DIR, 'Library', 'Application Support', 'Google'),
        )
      }
      break

    case 'win32':
      directories.push(
        join(appData, 'JetBrains'),
        join(localAppData, 'JetBrains'),
        join(appData),
      )
      if (ideNameLower === 'androidstudio') {
        directories.push(join(localAppData, 'Google'))
      }
      break

    case 'linux':
      directories.push(
        join(HOME_DIR, '.config', 'JetBrains'),
        join(HOME_DIR, '.local', 'share', 'JetBrains'),
      )
      for (const pattern of idePatterns) {
        directories.push(join(HOME_DIR, '.' + pattern))
      }
      if (ideNameLower === 'androidstudio') {
        directories.push(join(HOME_DIR, '.config', 'Google'))
      }
      break
    default:
      break
  }

  return directories
}

// Find all actual plugin directories that exist
async function detectPluginDirectories(ideName: string): Promise<string[]> {
  const foundDirectories: string[] = []
  const fs = getFsImplementation()

  const pluginDirPaths = buildCommonPluginDirectoryPaths(ideName)
  const regexes = getIdePatternRegexes(ideName)
  if (regexes.length === 0) {
    return foundDirectories
  }

  for (const baseDir of pluginDirPaths) {
    try {
      const entries = await fs.readdir(baseDir)
      for (const regex of regexes) {
        for (const entry of entries) {
          if (!regex.test(entry.name)) continue
          // Accept symlinks too — dirent.isDirectory() is false for symlinks,
          // but GNU stow users symlink their JetBrains config dirs. Downstream
          // fs.stat() calls will filter out symlinks that don't point to dirs.
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          const dir = join(baseDir, entry.name)
          // Linux is the only OS to not have a plugins directory
          if (platform() === 'linux') {
            foundDirectories.push(dir)
            continue
          }
          const pluginDir = join(dir, 'plugins')
          try {
            await fs.stat(pluginDir)
            foundDirectories.push(pluginDir)
          } catch {
            // Plugin directory doesn't exist, skip
          }
        }
      }
    } catch {
      // Ignore errors from stale IDE directories (ENOENT, EACCES, etc.)
      continue
    }
  }

  return foundDirectories.filter(
    (dir, index) => foundDirectories.indexOf(dir) === index,
  )
}

export async function isJetBrainsPluginInstalled(
  ideType: IdeType,
): Promise<boolean> {
  const pluginDirs = await detectPluginDirectories(ideType)
  for (const dir of pluginDirs) {
    const pluginPath = join(dir, PLUGIN_PREFIX)
    try {
      await getFsImplementation().stat(pluginPath)
      return true
    } catch {
      // Plugin not found in this directory, continue
    }
  }
  return false
}

const pluginInstalledCache = new Map<IdeType, boolean>()
const pluginInstalledPromiseCache = new Map<IdeType, Promise<boolean>>()

async function isJetBrainsPluginInstalledMemoized(
  ideType: IdeType,
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh) {
    const existing = pluginInstalledPromiseCache.get(ideType)
    if (existing) {
      return existing
    }
  }
  const promise = isJetBrainsPluginInstalled(ideType).then(result => {
    pluginInstalledCache.set(ideType, result)
    return result
  })
  pluginInstalledPromiseCache.set(ideType, promise)
  return promise
}

export async function isJetBrainsPluginInstalledCached(
  ideType: IdeType,
  forceRefresh = false,
): Promise<boolean> {
  if (forceRefresh) {
    pluginInstalledCache.delete(ideType)
    pluginInstalledPromiseCache.delete(ideType)
  }
  return isJetBrainsPluginInstalledMemoized(ideType, forceRefresh)
}

/**
 * Returns the cached result of isJetBrainsPluginInstalled synchronously.
 * Returns false if the result hasn't been resolved yet.
 * Use this only in sync contexts (e.g., status notice isActive checks).
 */
export function isJetBrainsPluginInstalledCachedSync(
  ideType: IdeType,
): boolean {
  return pluginInstalledCache.get(ideType) ?? false
}
