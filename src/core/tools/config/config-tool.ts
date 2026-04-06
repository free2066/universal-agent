/**
 * config-tool.ts — ConfigTool: LLM 读写 Agent 配置
 *
 * D22: 对标 claude-code src/tools/ConfigTool/ConfigTool.ts
 *
 * 提供两个工具让 LLM 可以动态读写 Agent 配置：
 *   - config_get: 读取当前配置值
 *   - config_set: 写入配置值（仅允许安全 key）
 *
 * 安全策略：
 *   - 仅允许 SAFE_CONFIG_KEYS 集合中的 key（防止 LLM 修改系统关键配置）
 *   - 写入前验证 key 合法性
 *   - 读取可以读取任意 key（但敏感 key 会被遮蔽）
 */

import type { ToolRegistration } from '../../../models/types.js';

/** D22: 允许 LLM 通过 config_set 修改的安全 key 集合 */
const SAFE_CONFIG_KEYS = new Set([
  'model',
  'approvalMode',
  'theme',
  'verbose',
  'outputStyle',
  'thinkingLevel',
  'language',
  'preferredEditor',
]);

/** D22: 敏感 key，读取时遮蔽显示 */
const SENSITIVE_CONFIG_KEYS = new Set(['apiKey', 'anthropicApiKey', 'openaiApiKey', 'token']);

/**
 * D22: config_get — 读取 Agent 配置值
 * 对标 claude-code ConfigTool get 操作。
 */
export const configGetTool: ToolRegistration = {
  definition: {
    name: 'config_get',
    description:
      'Get the current agent configuration value for a specific key. ' +
      'Useful for checking current model, approval mode, theme, etc.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Config key to read. Examples: model, approvalMode, theme, verbose, outputStyle, thinkingLevel',
        },
      },
      required: ['key'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const key = String(args.key ?? '');
    if (!key) return '[ConfigGet] key is required';

    try {
      const { loadConfig } = await import('../../../cli/config-store.js');
      const config = loadConfig() as Record<string, unknown>;
      const value = config[key] ?? null;

      if (SENSITIVE_CONFIG_KEYS.has(key)) {
        return JSON.stringify({ key, value: value ? '***' : null });
      }

      return JSON.stringify({ key, value });
    } catch (err) {
      return `[ConfigGet] Failed to read config: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * D22: config_set — 写入 Agent 配置值（仅允许安全 key）
 * 对标 claude-code ConfigTool set 操作。
 */
export const configSetTool: ToolRegistration = {
  definition: {
    name: 'config_set',
    description:
      'Set an agent configuration value at runtime. ' +
      `Only safe keys are allowed: ${[...SAFE_CONFIG_KEYS].join(', ')}. ` +
      'Changes take effect immediately for subsequent operations in this session.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: `Config key to set. Allowed keys: ${[...SAFE_CONFIG_KEYS].join(', ')}`,
        },
        value: {
          type: 'string',
          description: 'New value for the config key',
        },
      },
      required: ['key', 'value'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const key = String(args.key ?? '');
    const value = String(args.value ?? '');

    if (!key) return '[ConfigSet] key is required';
    if (!SAFE_CONFIG_KEYS.has(key)) {
      return (
        `[ConfigSet] Key "${key}" is not in the allowed list. ` +
        `Safe keys: ${[...SAFE_CONFIG_KEYS].join(', ')}`
      );
    }

    try {
      const { loadConfig, setConfigValue } = await import('../../../cli/config-store.js');
      const config = loadConfig() as Record<string, unknown>;
      const oldValue = config[key];
      setConfigValue(key, value);
      return JSON.stringify({
        key,
        oldValue: oldValue ?? null,
        newValue: value,
        status: 'saved',
      });
    } catch (err) {
      return `[ConfigSet] Failed to save config: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
