/**
 * services/settingsSync/index.ts — Settings synchronization service
 *
 * Mirrors claude-code's services/settingsSync/index.ts.
 * Manages reading, writing, and watching config/settings files.
 */

export {
  ThinkingLevelExtended,
  CommitConfig,
  UAgentConfig,
  ConfigValidationResult,
  globalConfigPath,
  projectConfigPath,
  projectLocalConfigPath,
  getPolicySettingsPath,
  setFlagSettings,
  getFlagSettings,
  parseFlagSettings,
  loadConfig,
  getConfigValue,
  setConfigValue,
  addConfigValue,
  removeConfigValue,
  formatConfigList,
  parseCliValue,
  validateConfig,
  runConfigMigrations,
} from '../../cli/config-store.js';
