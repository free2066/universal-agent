/**
 * models/llm-client.ts — 向后兼容转发层
 *
 * 原 1133 行单文件已拆分到 src/models/llm/ 目录：
 *   - llm/shared.ts      公共工具函数（withInferenceTimeout, safeParseJSON…）
 *   - llm/openai.ts      OpenAI + DeepSeek + Moonshot + Qwen + Mistral + Groq + SiliconFlow + OpenAICompat + OpenRouter
 *   - llm/anthropic.ts   Anthropic Claude（含 extended thinking）
 *   - llm/gemini.ts      Google Gemini
 *   - llm/ollama.ts      Ollama 本地模型
 *   - llm/factory.ts     createLLMClient 工厂函数
 *   - llm/index.ts       汇总 re-export
 *
 * 此文件保留以不破坏现有 import './llm-client.js' 路径。
 * 新代码请直接 import from './llm/index.js' 或具体的 Provider 文件。
 */
export { createLLMClient } from './llm/factory.js';
export { OpenAIClient } from './llm/openai.js';
export type { } from './types.js';
