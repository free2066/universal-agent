/**
 * Token Estimation Utility
 * 
 * Provides local token estimation for models that don't return correct usage data.
 * Uses a simple character-based estimation with model-specific multipliers.
 */

/** Known token-to-char ratios for different model families */
const TOKEN_RATIOS: Record<string, number> = {
  // Chinese models have higher ratio due to Chinese characters
  'glm': 0.5,      // ~2 chars per token for Chinese
  'qwen': 0.5,
  'deepseek': 0.5,
  'moonshot': 0.5,
  'kimi': 0.5,
  
  // English-centric models
  'gpt': 0.25,     // ~4 chars per token
  'claude': 0.25,
  'gemini': 0.25,
  'mistral': 0.25,
  'llama': 0.25,
  
  // Default fallback
  'default': 0.33,
};

/**
 * Estimate token count from text content
 * Uses character-based estimation with model-specific adjustments
 */
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0;
  
  const charCount = text.length;
  
  // Get the appropriate ratio based on model family
  let ratio = TOKEN_RATIOS.default;
  if (model) {
    const modelLower = model.toLowerCase();
    for (const [family, r] of Object.entries(TOKEN_RATIOS)) {
      if (modelLower.includes(family)) {
        ratio = r;
        break;
      }
    }
  }
  
  // Add overhead for structure (JSON, code, etc.)
  const structureOverhead = countStructureOverhead(text);
  
  return Math.ceil(charCount * ratio + structureOverhead);
}

/**
 * Count structural tokens that add overhead
 * (brackets, quotes, newlines, etc.)
 */
function countStructureOverhead(text: string): number {
  let overhead = 0;
  
  // Count JSON/code structural characters
  const structuralChars = ['{', '}', '[', ']', '"', "'", '\n', '\t', ':', ','];
  for (const char of structuralChars) {
    const count = (text.match(new RegExp('\\' + char, 'g')) || []).length;
    overhead += count * 0.1; // Each structural char adds ~0.1 token overhead
  }
  
  return overhead;
}

/**
 * Estimate input tokens for a chat request
 */
export function estimateInputTokens(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  model?: string
): number {
  let total = estimateTokens(systemPrompt, model);
  
  for (const msg of messages) {
    // Add role overhead (~4 tokens per message)
    total += 4;
    total += estimateTokens(msg.content, model);
  }
  
  return total;
}

/**
 * Estimate output tokens based on response
 */
export function estimateOutputTokens(
  content: string,
  model?: string
): number {
  return estimateTokens(content, model);
}

/**
 * Check if usage data looks invalid (all zeros)
 */
export function isUsageInvalid(usage?: { input_tokens: number; output_tokens: number }): boolean {
  if (!usage) return true;
  return usage.input_tokens === 0 && usage.output_tokens === 0;
}

/**
 * Get estimated usage if API returns invalid data
 */
export function getEstimatedUsage(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  responseContent: string,
  model?: string
): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: estimateInputTokens(systemPrompt, messages, model),
    output_tokens: estimateOutputTokens(responseContent, model),
  };
}
