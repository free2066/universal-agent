// @ts-nocheck
/**
 * src/services/modelPrompt/index.ts
 *
 * G3: Model-specific prompt hot-reload service.
 *
 * Loads per-model behavioral rules from .md files instead of hardcoded TS.
 * Priority (highest to lowest):
 *   1. ~/.uagent/model-prompts/{family}.md  — user overrides
 *   2. builtin model-prompts/ directory (shipped with CLI)
 *
 * This enables PM/engineers to adjust model behavior without rebuilding.
 *
 * Inspired by opencode's session/prompt/ directory (beast.txt, gemini.txt, etc.)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// Simple in-process cache — avoids repeated disk reads per request
const promptCache = new Map<string, string | null>()

// Builtin prompts directory (co-located with omo-agents plugin)
const BUILTIN_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../builtin-plugins/omo-agents/model-prompts',
)

// User override directory
const USER_DIR = path.join(os.homedir(), '.uagent', 'model-prompts')

/**
 * Determine the prompt "family" key for a given model name.
 * Returns a filename stem like 'gemini', 'gpt-o', 'gpt-4o', 'deepseek', 'qwen'.
 */
function getPromptFamily(modelName: string): string | null {
  const lower = modelName.toLowerCase()

  if (lower.startsWith('gemini') || lower.includes('gemini')) return 'gemini'

  // o-series reasoning models (o1, o3, o4, o1-mini, o3-mini, etc.)
  if (/\bo[1-9][-\w]*/.test(lower) || lower.includes('-o1') || lower.includes('-o3') || lower.includes('-o4')) {
    return 'gpt-o'
  }

  if (lower.startsWith('gpt-4') || lower.includes('gpt-4o')) return 'gpt-4o'

  if (lower.startsWith('deepseek') || lower.includes('deepseek')) return 'deepseek'

  if (lower.startsWith('qwen') || lower.includes('qwen')) return 'qwen'

  // Kimi / Moonshot — similar to GPT family
  if (lower.startsWith('moonshot') || lower.includes('kimi')) return 'gpt-4o'

  return null
}

/**
 * Try to read a .md file from a directory, return its trimmed content or null.
 */
function tryReadPromptFile(dir: string, filename: string): string | null {
  const filepath = path.join(dir, filename)
  try {
    const content = fs.readFileSync(filepath, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

/**
 * Get model-specific prompt rules for a model name.
 *
 * Checks user override dir first, then builtin dir.
 * Results are cached to avoid repeated disk reads.
 *
 * @returns The prompt content (e.g. `<model_specific_rules>...</model_specific_rules>`) or null
 */
export function getModelPromptRules(modelName: string): string | null {
  const family = getPromptFamily(modelName)
  if (!family) return null

  const cacheKey = family
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey)!

  const filename = `${family}.md`

  // 1. Try user override
  const userContent = tryReadPromptFile(USER_DIR, filename)
  if (userContent) {
    promptCache.set(cacheKey, userContent)
    return userContent
  }

  // 2. Try builtin
  const builtinContent = tryReadPromptFile(BUILTIN_DIR, filename)
  promptCache.set(cacheKey, builtinContent)
  return builtinContent
}

/**
 * Clear the cache — useful when user overrides are changed at runtime.
 * Called automatically when UA_MODEL_PROMPT_DIR changes are detected (future).
 */
export function clearModelPromptCache(): void {
  promptCache.clear()
}
