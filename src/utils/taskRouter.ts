/**
 * src/utils/taskRouter.ts
 *
 * Task Router — classifies user requests into categories and resolves the
 * appropriate model to use, inspired by oh-my-openagent's category-based
 * model routing system.
 *
 * Usage:
 *   const result = await classifyAndRoute(userPrompt)
 *   if (result) {
 *     // Use result.model instead of the default main model
 *   }
 *
 * The router is opt-in — it only activates when ~/.uagent/task-router.json
 * exists and has "enabled": true.
 */

import {
  type TaskCategory,
  getClassifierModel,
  getFallbackModels,
  getModelForCategory,
  isTaskRoutingEnabled,
  loadTaskRouterConfig,
} from './taskRouterConfig.js'
import { logForDebugging } from './debug.js'

export type { TaskCategory }

/** Result returned by classifyAndRoute(). */
export interface TaskRouteResult {
  /** Detected task category. */
  category: TaskCategory
  /** Model to use for this task (may differ from the main loop model). */
  model: string
  /** List of fallback models in priority order. */
  fallbackModels: string[]
  /** Confidence of the classification (0-1, heuristic-based). */
  confidence: number
  /** How the model was resolved ('configured' | 'default' | 'fallback'). */
  resolution: 'configured' | 'default' | 'fallback'
}

// ---------------------------------------------------------------------------
// Heuristic-based classifier
// ---------------------------------------------------------------------------

/**
 * Keyword patterns for each category. Evaluated in order — first match wins.
 * Patterns are case-insensitive and matched against the full prompt text.
 */
const CATEGORY_PATTERNS: Array<{
  category: TaskCategory
  patterns: RegExp[]
  confidence: number
}> = [
  {
    category: 'git',
    patterns: [
      /\b(commit|git\s+commit|git\s+push|git\s+pull|git\s+merge|git\s+rebase)\b/i,
      /\b(branch|stash|cherry.pick|git\s+log|git\s+diff|git\s+status)\b/i,
      /\b(pr|pull\s+request|merge\s+request)\s+(description|message|title)\b/i,
      /\bwrite\s+(a\s+)?commit\s+message\b/i,
    ],
    confidence: 0.85,
  },
  {
    category: 'writing',
    patterns: [
      /\b(write|update|improve|fix|generate)\s+(the\s+)?(readme|documentation|docs|changelog|release\s+notes|comments?|jsdoc|tsdoc)\b/i,
      /\badd\s+(documentation|comments?|docstrings?)\b/i,
      /\b(summarize|explain|describe)\b/i,
    ],
    confidence: 0.75,
  },
  {
    category: 'quick',
    patterns: [
      /\b(fix|correct)\s+(a\s+)?(typo|spelling|formatting|lint\s+error)\b/i,
      /\brename\s+(variable|function|class|file|method)\b/i,
      /\bchange\s+(the\s+)?(color|font|size|margin|padding|label|text)\b/i,
      /\badd\s+(a\s+)?(console\.log|print|log)\b/i,
      /\bsmall\s+(fix|change|tweak|update)\b/i,
    ],
    confidence: 0.8,
  },
  {
    category: 'visual-engineering',
    patterns: [
      /\b(ui|ux|frontend|front-end|css|tailwind|styled.components?|scss|less)\b/i,
      /\b(react|vue|svelte|angular|component|layout|responsive|mobile)\b/i,
      /\b(design|animation|transition|hover|dark\s+mode|theme)\b/i,
      /\b(figma|wireframe|mockup|prototype)\b/i,
    ],
    confidence: 0.8,
  },
  {
    category: 'debug',
    patterns: [
      /\b(debug|trace|diagnose|investigate|root\s+cause|why\s+(is|does|did|are))\b/i,
      /\b(error|exception|crash|bug|broken|not\s+working|failing)\b/i,
      /\b(stack\s+trace|segfault|memory\s+leak|race\s+condition|deadlock)\b/i,
    ],
    confidence: 0.75,
  },
  {
    category: 'deep',
    patterns: [
      /\b(algorithm|complexity|optimization|performance|profiling)\b/i,
      /\b(architecture|design\s+pattern|refactor|restructure|migrate)\b/i,
      /\b(research|analyze|investigate|reverse\s+engineer)\b/i,
      /\b(implement\s+(from\s+scratch|a\s+(complete|full|entire)))\b/i,
    ],
    confidence: 0.7,
  },
  {
    category: 'unspecified-high',
    patterns: [
      /\b(build|create|implement|develop)\s+(a\s+)?(new\s+)?(feature|system|module|service|api|endpoint)\b/i,
      /\b(integrate|connect|setup|configure)\b/i,
      /\b(complex|advanced|sophisticated)\b/i,
      /\b(multi.step|step.by.step|end.to.end|full.stack)\b/i,
    ],
    confidence: 0.6,
  },
]

/** Default category when no patterns match. */
const DEFAULT_CATEGORY: TaskCategory = 'unspecified-low'

/**
 * Classify a user prompt into a TaskCategory using heuristic pattern matching.
 * This is purely client-side — no LLM call required.
 *
 * @returns The detected category and confidence level.
 */
export function classifyPromptHeuristic(prompt: string): {
  category: TaskCategory
  confidence: number
} {
  const normalized = prompt.trim()

  for (const { category, patterns, confidence } of CATEGORY_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return { category, confidence }
      }
    }
  }

  return { category: DEFAULT_CATEGORY, confidence: 0.4 }
}

// ---------------------------------------------------------------------------
// Model resolver
// ---------------------------------------------------------------------------

/**
 * Given a classified category, resolve the model to use.
 * Priority order:
 *  1. Category-specific model from config
 *  2. Global fallback models from config
 *  3. null (caller should use the default main loop model)
 */
export function resolveModelForCategory(category: TaskCategory): {
  model: string
  fallbackModels: string[]
  resolution: 'configured' | 'default' | 'fallback'
} | null {
  const configuredModel = getModelForCategory(category)
  const fallbacks = getFallbackModels(category)

  if (configuredModel) {
    return {
      model: configuredModel,
      fallbackModels: fallbacks,
      resolution: 'configured',
    }
  }

  if (fallbacks.length > 0) {
    const [first, ...rest] = fallbacks
    return { model: first!, fallbackModels: rest, resolution: 'fallback' }
  }

  return null
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

/**
 * Classify the user's prompt and resolve the appropriate model to use.
 *
 * Returns null if:
 * - Task routing is disabled (no config file or enabled=false)
 * - No model is configured for the detected category
 *
 * @param prompt The raw user message / task description.
 * @returns TaskRouteResult if routing applies, null otherwise.
 */
export function classifyAndRoute(prompt: string): TaskRouteResult | null {
  if (!isTaskRoutingEnabled()) {
    return null
  }

  const { category, confidence } = classifyPromptHeuristic(prompt)
  const resolved = resolveModelForCategory(category)

  if (!resolved) {
    logForDebugging(
      `[TaskRouter] No model configured for category "${category}", using default`,
      { level: 'info' },
    )
    return null
  }

  logForDebugging(
    `[TaskRouter] Classified "${prompt.slice(0, 80)}..." → category="${category}" (confidence=${confidence.toFixed(2)}), model="${resolved.model}"`,
    { level: 'info' },
  )

  return {
    category,
    model: resolved.model,
    fallbackModels: resolved.fallbackModels,
    confidence,
    resolution: resolved.resolution,
  }
}

/**
 * Get a human-readable summary of the current task router configuration.
 * Useful for /config or debug output.
 */
export function getTaskRouterSummary(): string {
  const cfg = loadTaskRouterConfig()
  if (!cfg) {
    return 'Task router: disabled (no ~/.uagent/task-router.json found)'
  }
  if (!cfg.enabled) {
    return 'Task router: disabled (enabled=false in config)'
  }

  const categories = cfg.categories ?? {}
  const lines = ['Task router: enabled']
  for (const [cat, catCfg] of Object.entries(categories)) {
    lines.push(`  ${cat}: ${catCfg.model}`)
  }
  if (cfg.fallback_models?.length) {
    lines.push(`  fallback: ${cfg.fallback_models.join(', ')}`)
  }
  return lines.join('\n')
}

// Re-export config types for convenience
export type { TaskCategory as RouterCategory }
