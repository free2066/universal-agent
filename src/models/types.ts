// Shared type definitions across the agent framework

/** Vision image block — base64 encoded, compatible with OpenAI and Anthropic vision APIs */
export interface ImageBlock {
  type: 'image';
  /** base64-encoded image data (WITHOUT the "data:..." URI prefix) */
  data: string;
  /** MIME type, e.g. "image/png" */
  mimeType: string;
}

/** URL-referenced image block (OpenAI vision image_url format) */
export interface ImageUrlBlock {
  type: 'image_url';
  url: string;
}

/** A single content block in a multimodal message */
export type ContentBlock = string | ImageBlock | ImageUrlBlock;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Either a plain string or a multimodal content array */
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * LLM API usage data attached after each assistant response.
   * Used by countTokensFromHistory() for precise token counting
   * without an additional network round-trip.
   * Mirrors claude-code's AssistantMessage.usage field.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * Unique message ID from the LLM API response.
   * Used for parallel tool call sibling detection in token counting:
   * parallel tool_use produces multiple assistant records sharing the same messageId.
   */
  messageId?: string;
}

/** Extract the plain-text portion of a message's content (for logging / display). */
export function getContentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b.type === 'image') return '[image]';
      if (b.type === 'image_url') return `[image: ${b.url}]`;
      return '';
    })
    .join('');
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ParameterSchema>;
    required?: string[];
  };
  /**
   * I13: 向后兼容别名（claude-code Tool.aliases 对标）
   * 工具重命名后旧名称仍可查找，防止 SDK 用旧名称调用报 "Unknown tool" 错误。
   * 示例: aliases: ['read_file', 'readFile'] 使 'Read' 工具可被旧名称调用。
   */
  aliases?: string[];
}

export interface ParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ParameterSchema;
  /** For object-typed parameters: nested property definitions */
  properties?: Record<string, ParameterSchema>;
  required?: string[];
}

/** Claude extended-thinking budget levels */
export type ThinkingLevel =
  | 'low' | 'medium' | 'high'    // all providers
  | 'max' | 'xhigh' | 'maxOrXhigh' // extended (Claude / advanced)
  | 'adaptive';  // Round 7: auto-select budget based on model name

/** Budget tokens per level (aligns with Anthropic docs) */
export const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, 'adaptive'>, number> = {
  low:          1_024,
  medium:       8_000,
  high:        16_000,
  max:         32_000,
  xhigh:       32_000,
  maxOrXhigh:  32_000,   // prefer xhigh; fall back to max on unsupported models
};

/**
 * Resolve 'adaptive' thinking level to a concrete level based on model name.
 * (Round 7: claude-code adaptive thinking parity)
 *   - claude-opus-* / claude-3-opus-*  → 'high' (16k tokens)
 *   - claude-sonnet-* / claude-3-*     → 'medium' (8k tokens)
 *   - other models                     → undefined (disable thinking)
 */
export function resolveAdaptiveThinking(
  thinkingLevel: ThinkingLevel | undefined,
  modelName: string,
): Exclude<ThinkingLevel, 'adaptive'> | undefined {
  if (thinkingLevel !== 'adaptive') return thinkingLevel as Exclude<ThinkingLevel, 'adaptive'> | undefined;
  const lower = modelName.toLowerCase();
  if (lower.includes('opus')) return 'high';       // opus → 16k budget
  if (lower.includes('sonnet')) return 'medium';   // sonnet → 8k budget
  return undefined;                                 // others → disable
}

export interface ChatOptions {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
  /** Claude extended-thinking level (only applied for claude-* models) */
  thinkingLevel?: ThinkingLevel;
  /**
   * StreamingToolExecutor callback (claude-code parity).
   * Called for each partial tool call JSON delta during streaming.
   * Allows eager tool execution before the stream completes.
   *
   * @param index     Tool call index (0-based)
   * @param toolName  Tool name (set on first chunk for each index)
   * @param deltaArgs Partial JSON string for this chunk
   * @param toolCallId  Optional ID from the LLM stream
   */
  onToolCallDelta?: (index: number, toolName: string, deltaArgs: string, toolCallId?: string) => void;
}

/**
 * ChatResponse uses a discriminated union to let TypeScript narrow the type
 * in conditional branches:
 *
 *   if (response.type === 'text') { /* response.toolCalls is never here *\/ }
 *   if (response.type === 'tool_calls') { /* response.toolCalls is ToolCall[] here *\/ }
 *
 * This prevents accidentally reading toolCalls on a text-only response and
 * makes every LLMClient implementation's return types self-documenting.
 */
export type ChatResponse =
  | { type: 'text';       content: string; toolCalls?: never }
  | { type: 'tool_calls'; content: string; toolCalls: ToolCall[] };

export interface LLMClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
  /**
   * Stream the LLM response, calling onChunk for each text delta.
   * Also accumulates any tool_calls and returns a full ChatResponse on completion.
   * This allows the agent loop to use streamChat() exclusively — text is streamed
   * to the user in real-time while tool_calls are still available for the agent.
   */
  streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * D18 (claude-code Tool.ValidationResult parity): Tool semantic validation result.
 * Returned by ToolRegistration.validate() — used by tool-registry execute() pipeline.
 *
 * errorCode provides LLM-readable failure context for self-correction.
 * Examples: 'file_not_found', 'permission_denied', 'invalid_format', 'out_of_range'
 */
export type ToolValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode?: string };

// ── Plugin Slash Command ──────────────────────────────────────────────────────

/**
 * A slash command contributed by a DomainPlugin.
 *
 * @example
 * ```js
 * // .uagent/plugins/my-plugin.js
 * export default {
 *   name: 'my-plugin',
 *   // ...
 *   slashCommands: [
 *     {
 *       command: '/standup',
 *       description: 'Print daily standup template',
 *       handler: async (args, ctx) => {
 *         ctx.onChunk('## Standup\n- Yesterday:\n- Today:\n- Blockers:\n');
 *       },
 *     },
 *   ],
 * };
 * ```
 */
export interface PluginSlashCommand {
  /** The /command string (must start with '/') */
  command: string;
  /** Short description shown in /help */
  description: string;
  /**
   * Handler called when user types the command.
   * @param args  Everything after the command (may be empty string)
   * @param ctx   Minimal context: onChunk (stream text to user), agentHistory
   */
  handler: (args: string, ctx: PluginSlashContext) => Promise<void>;
}

/** Minimal context passed to plugin slash command handlers */
export interface PluginSlashContext {
  /** Stream text output to the user */
  onChunk: (chunk: string) => void;
  /** Current conversation history (read-only) */
  agentHistory: readonly unknown[];
  /** Current working directory */
  cwd: string;
}

// ── Plugin Hook ───────────────────────────────────────────────────────────────

/**
 * A hook contributed by a DomainPlugin.
 * Uses the same HookEvent/HookType system as .uagent/hooks.json.
 */
export interface PluginHookDefinition {
  /** Which lifecycle event to intercept */
  event: 'pre_prompt' | 'post_response' | 'on_tool_call' | 'on_session_end';
  /** Description shown in /hooks list */
  description?: string;
  /** Whether the hook is active (default: true) */
  enabled?: boolean;
  /**
   * Inline handler (takes precedence over shell command_line).
   * Return a string to replace/augment the input; return undefined to pass through.
   */
  handler?: (payload: Record<string, unknown>) => Promise<string | undefined>;
  /** Shell command line fallback (used when handler is not provided) */
  command_line?: string;
  /** For on_tool_call: only fire for this tool name */
  tool?: string;
}

// ── DomainPlugin ──────────────────────────────────────────────────────────────

export interface DomainPlugin {
  name: string;
  description: string;
  keywords: string[];
  systemPrompt: string;
  tools: ToolRegistration[];
  /** Optional: slash commands contributed by this plugin */
  slashCommands?: PluginSlashCommand[];
  /** Optional: hooks contributed by this plugin */
  hooks?: PluginHookDefinition[];
}

export interface ToolRegistration {
  definition: ToolDefinition;
  handler: ToolHandler;
  /**
   * D18 (claude-code Tool.validateInput parity): Optional semantic validation.
   * Called AFTER JSON schema validation, BEFORE tool handler execution.
   * Provides domain-specific checks with structured errorCode for LLM self-correction.
   *
   * Return { result: true } to allow; { result: false, message, errorCode } to block.
   * errorCode gives the LLM actionable context (e.g. 'file_not_found', 'permission_denied').
   */
  validate?: (args: Record<string, unknown>) => ToolValidationResult | Promise<ToolValidationResult>;
  /** F12: Maximum result size in bytes before auto-persisting to temp file (default 50KB). */
  maxResultSizeBytes?: number;
  /** Whether this is an MCP tool (affects tool pool partitioning) */
  isMcp?: boolean;
  /** Whether to defer loading this tool until explicitly requested via ToolSearch */
  shouldDefer?: boolean;
  /** Whether to always load this tool regardless of defer threshold */
  alwaysLoad?: boolean;
  /**
   * A18 (claude-code contextModifier parity): Optional modifier applied after tool execution.
   * Allows tools (EnterPlanMode, WorktreeEnter, etc.) to update agent session state
   * (cwd, approvalMode, etc.) without tight coupling to the agent loop.
   *
   * Called by agent-loop after tool batch completion; result replaces current AgentContextState.
   * Mirrors claude-code StreamingToolExecutor.ts TrackedTool.contextModifiers[].
   *
   * @param ctx  Current agent context state
   * @returns    Updated agent context state (must return new object, not mutate in place)
   */
  contextModifier?: (ctx: AgentContextState) => AgentContextState;
}

/**
 * A18: Session-level agent context state that tools can modify via contextModifier.
 * Mirrors claude-code's ToolUseContext (the mutable portion).
 */
export interface AgentContextState {
  /** Current working directory for the agent session */
  cwd: string;
  /** Current approval/permission mode */
  approvalMode: 'default' | 'autoEdit' | 'yolo';
  /** Whether plan mode is active (blocks write tools) */
  planModeActive: boolean;
  /** Pre-plan-mode approval mode (E18: restored on exit) */
  prePlanApprovalMode?: 'default' | 'autoEdit' | 'yolo';
}
