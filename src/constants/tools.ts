/**
 * constants/tools.ts — Tool name constants
 *
 * Mirrors claude-code's constants/tools.ts.
 * Central registry of all tool name strings.
 */

// ── Core tool names ───────────────────────────────────────────────────────────

export const BASH_TOOL_NAME = 'Bash';
export const FILE_READ_TOOL_NAME = 'Read';
export const FILE_WRITE_TOOL_NAME = 'Write';
export const FILE_EDIT_TOOL_NAME = 'Edit';
export const GLOB_TOOL_NAME = 'Glob';
export const GREP_TOOL_NAME = 'Grep';
export const LS_TOOL_NAME = 'LS';

// ── Agent tools ───────────────────────────────────────────────────────────────

export const AGENT_TOOL_NAME = 'Task';
export const TODO_WRITE_TOOL_NAME = 'TodoWrite';
export const TODO_READ_TOOL_NAME = 'TodoRead';
export const WEB_FETCH_TOOL_NAME = 'WebFetch';
export const WEB_SEARCH_TOOL_NAME = 'WebSearch';
export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit';

// ── MCP tools ─────────────────────────────────────────────────────────────────

export const MCP_TOOL_PREFIX = 'mcp__';
export const LIST_MCP_RESOURCES_TOOL_NAME = 'mcp__list_resources';
export const READ_MCP_RESOURCE_TOOL_NAME = 'mcp__read_resource';
export const MCP_AUTH_TOOL_NAME = 'mcp__auth';

// ── Plan mode tools ───────────────────────────────────────────────────────────

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

// ── Worktree tools ────────────────────────────────────────────────────────────

export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree';
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree';

// ── Productivity tools ────────────────────────────────────────────────────────

export const SLEEP_TOOL_NAME = 'Sleep';
export const SKILL_TOOL_NAME = 'Skill';
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';
export const SYNTHETIC_OUTPUT_TOOL_NAME = 'SyntheticOutput';

// ── Cron tools ────────────────────────────────────────────────────────────────

export const CRON_CREATE_TOOL_NAME = 'ScheduleCron';
export const CRON_DELETE_TOOL_NAME = 'UnscheduleCron';
export const CRON_LIST_TOOL_NAME = 'ListCrons';

// ── Task tools ────────────────────────────────────────────────────────────────

export const TASK_CREATE_TOOL_NAME = 'CreateTask';
export const TASK_GET_TOOL_NAME = 'GetTask';
export const TASK_LIST_TOOL_NAME = 'ListTasks';
export const TASK_UPDATE_TOOL_NAME = 'UpdateTask';
export const TASK_STOP_TOOL_NAME = 'StopTask';

// ── Team tools ────────────────────────────────────────────────────────────────

export const TEAM_CREATE_TOOL_NAME = 'CreateTeam';
export const TEAM_DELETE_TOOL_NAME = 'DeleteTeam';
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

// ── Config tool ───────────────────────────────────────────────────────────────

export const CONFIG_TOOL_NAME = 'Config';

// ── LSP tool ──────────────────────────────────────────────────────────────────

export const LSP_TOOL_NAME = 'LSP';

// ── universal-agent exclusive tools ──────────────────────────────────────────

export const CODE_INSPECTOR_TOOL_NAME = 'InspectCode';
export const AI_REVIEWER_TOOL_NAME = 'AiReview';
export const SELF_HEAL_TOOL_NAME = 'SelfHeal';
export const SPEC_GENERATOR_TOOL_NAME = 'GenSpec';
export const REVERSE_ANALYZE_TOOL_NAME = 'ReverseAnalyze';
export const DATABASE_QUERY_TOOL_NAME = 'DatabaseQuery';
export const REDIS_PROBE_TOOL_NAME = 'RedisProbe';
export const ENV_PROBE_TOOL_NAME = 'EnvProbe';
