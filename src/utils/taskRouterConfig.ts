/**
 * src/utils/taskRouterConfig.ts
 *
 * Task Router Configuration — reads ~/.uagent/task-router.json and provides
 * typed access to the category→model mapping.
 *
 * Inspired by oh-my-openagent's category-based model routing system.
 * Reference: https://github.com/code-yeongyu/oh-my-openagent
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

/** Task categories that the router can classify a user request into. */
export type TaskCategory =
  | 'quick'              // Single-file edits, typos, simple changes → fast/cheap model
  | 'unspecified-low'    // General medium-difficulty tasks → mid-tier model
  | 'unspecified-high'   // Complex architecture, full-feature implementation → best model
  | 'visual-engineering' // Frontend/UI/UX/design → model with strong visual understanding
  | 'deep'               // Deep research, algorithm design, reverse engineering
  | 'writing'            // Documentation, comments, changelog → lightweight model
  | 'git'                // Git operations, commit messages → lightweight model
  | 'debug'              // Debugging, root cause analysis → reasoning model

/** Per-category model configuration. */
export interface CategoryConfig {
  /** Model name (profile name or model string like "glm-5", "gemini-2.5-pro"). */
  model: string
  /** Optional fallback models in priority order if the primary fails. */
  fallback_models?: string[]
}

/** Runtime fallback policy when API calls fail. */
export interface RuntimeFallbackConfig {
  enabled: boolean
  /** HTTP status codes that trigger a fallback attempt. */
  retry_on_errors?: number[]
  /** Maximum number of fallback attempts before giving up. */
  max_fallback_attempts?: number
}

/** Full task router configuration. */
export interface TaskRouterConfig {
  /** Whether task routing is enabled. Default: false (opt-in). */
  enabled: boolean
  /**
   * Model used to classify the user's intent (should be fast and cheap).
   * Defaults to the 'quick' pointer from ModelManager if not set.
   */
  classifier_model?: string
  /** Category-specific model overrides. */
  categories?: Partial<Record<TaskCategory, CategoryConfig>>
  /** Global fallback models if no category-specific model is available. */
  fallback_models?: string[]
  /** Runtime fallback policy. */
  runtime_fallback?: RuntimeFallbackConfig
}

const CONFIG_DIR = resolve(homedir(), '.uagent')
const CONFIG_FILE_ENV = process.env.UA_TASK_ROUTER_CONFIG
const CONFIG_FILE_DEFAULT = resolve(CONFIG_DIR, 'task-router.json')

let _cachedConfig: TaskRouterConfig | null | undefined = undefined

/**
 * Load the task router configuration from disk.
 * Returns null if the file doesn't exist (routing is disabled by default).
 * Caches the result in memory after first read.
 */
export function loadTaskRouterConfig(): TaskRouterConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig

  const configPath = CONFIG_FILE_ENV || CONFIG_FILE_DEFAULT

  if (!existsSync(configPath)) {
    _cachedConfig = null
    return null
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as TaskRouterConfig
    // Normalize: if enabled field is missing, assume true when file exists
    if (typeof parsed.enabled !== 'boolean') {
      parsed.enabled = true
    }
    _cachedConfig = parsed
    return parsed
  } catch (err) {
    // Malformed config — disable routing gracefully, but warn so users know
    // their budget caps (dailyCostLimitUSD etc.) are NOT active.
    process.stderr.write(`[task-router] WARNING: Failed to parse config at ${configPath}: ${String(err)}\n`)
    _cachedConfig = null
    return null
  }
}

/**
 * Reset the config cache. Useful in tests or after updating the config file.
 */
export function resetTaskRouterConfigCache(): void {
  _cachedConfig = undefined
}

/**
 * Returns true if task routing is enabled and configured.
 */
export function isTaskRoutingEnabled(): boolean {
  const cfg = loadTaskRouterConfig()
  return cfg !== null && cfg.enabled === true
}

/**
 * Get the model configured for a specific category.
 * Returns null if no override is configured for that category.
 */
export function getModelForCategory(category: TaskCategory): string | null {
  const cfg = loadTaskRouterConfig()
  if (!cfg) return null
  return cfg.categories?.[category]?.model ?? null
}

/**
 * Get the classifier model (used to determine task category).
 * Returns null if not configured (caller should fall back to 'quick' pointer).
 */
export function getClassifierModel(): string | null {
  const cfg = loadTaskRouterConfig()
  return cfg?.classifier_model ?? null
}

/**
 * Get fallback models for a given category, merging category-level and global fallbacks.
 */
export function getFallbackModels(category: TaskCategory): string[] {
  const cfg = loadTaskRouterConfig()
  if (!cfg) return []
  const categoryFallbacks = cfg.categories?.[category]?.fallback_models ?? []
  const globalFallbacks = cfg.fallback_models ?? []
  // Deduplicate while preserving order: category-level first, then global
  const seen = new Set<string>()
  return [...categoryFallbacks, ...globalFallbacks].filter(m => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })
}

/**
 * Example config file written to ~/.uagent/task-router.json for first-time setup.
 */
export const EXAMPLE_TASK_ROUTER_CONFIG: TaskRouterConfig = {
  enabled: true,
  classifier_model: 'glm-4-flash',
  categories: {
    quick: { model: 'glm-4-flash' },
    'unspecified-low': { model: 'glm-5' },
    'unspecified-high': { model: 'glm-5-thinking' },
    'visual-engineering': { model: 'gemini-2.5-pro' },
    deep: { model: 'glm-5-thinking' },
    writing: { model: 'glm-4-flash' },
    git: { model: 'glm-4-flash' },
    debug: { model: 'glm-5' },
  },
  fallback_models: ['glm-5', 'gemini-2.5-flash'],
  runtime_fallback: {
    enabled: true,
    retry_on_errors: [429, 503],
    max_fallback_attempts: 3,
  },
}
