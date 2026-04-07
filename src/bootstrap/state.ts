/**
 * bootstrap/state.ts — Global session state for universal-agent
 *
 * Mirrors claude-code's bootstrap/state.ts architecture.
 * Centralizes all session-scoped globals in a single typed State object
 * to avoid scattered module-level variables.
 *
 * DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
 */

import { randomUUID } from 'crypto';

// ── Session ID ────────────────────────────────────────────────────────────────

export type SessionId = string & { readonly __brand: 'SessionId' };

function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

// ── Channel Entry ─────────────────────────────────────────────────────────────

export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean };

// ── QuerySource — LLM call source identification ─────────────────────────────
// Mirrors claude-code's QuerySource / agent/types.ts QuerySource enum.
// Used for retry gating, prompt cache TTL, and memory trigger precision.

export type QuerySource =
  // Foreground (interactive / user-facing)
  | 'repl_main_thread'
  | 'repl_main_thread:compact'
  | 'agent_main'
  | 'compact'
  | 'agent:coordinator'
  | 'hook_agent'
  | 'side_question'
  // Background (fire-and-forget)
  | 'agent'
  | 'agent:autopilot'
  | 'agent:teammate'
  | 'tool_summary'
  | 'session_memory'
  | 'verification_agent'
  | 'auto_dream'
  | 'cron'
  | 'speculation'
  | 'background_title'
  | 'background_classifier'
  | 'agent_summarization';

// ── SessionCronTask ───────────────────────────────────────────────────────────

export interface SessionCronTask {
  id: string;
  expression: string;
  command: string;
  createdAt: number;
}

// ── InvokedSkill ──────────────────────────────────────────────────────────────

export interface InvokedSkill {
  skillName: string;
  skillPath: string;
  content: string;
  invokedAt: number;
  agentId: string;
}

// ── SlowOperation ─────────────────────────────────────────────────────────────

export interface SlowOperation {
  operation: string;
  durationMs: number;
  timestamp: number;
}

// ── State type ────────────────────────────────────────────────────────────────

type State = {
  /** Current working directory */
  cwd: string;
  /** Stable project root — set once at startup */
  projectRoot: string;
  /** Original cwd at startup */
  originalCwd: string;
  /** Current session ID */
  sessionId: SessionId;
  /** Parent session ID (for sub-agents) */
  parentSessionId: SessionId | undefined;

  // Cost tracking
  totalCostUSD: number;
  totalAPIDuration: number;
  totalAPIDurationWithoutRetries: number;
  totalToolDuration: number;

  // Turn-level stats
  turnHookDurationMs: number;
  turnToolDurationMs: number;
  turnClassifierDurationMs: number;
  turnToolCount: number;
  turnHookCount: number;
  turnClassifierCount: number;

  // Timing
  startTime: number;
  lastInteractionTime: number;

  // Line change tracking
  totalLinesAdded: number;
  totalLinesRemoved: number;

  // Model state
  hasUnknownModelCost: boolean;
  mainLoopModelOverride: string | undefined;

  // Session flags
  isInteractive: boolean;
  isRemoteMode: boolean;
  strictToolResultPairing: boolean;
  userMsgOptIn: boolean;
  clientType: string;
  sessionSource: string | undefined;

  // Settings
  flagSettingsPath: string | undefined;
  flagSettingsInline: Record<string, unknown> | null;

  // OAuth
  sessionIngressToken: string | null | undefined;
  oauthTokenFromFd: string | null | undefined;
  apiKeyFromFd: string | null | undefined;

  // Cron tasks (session-only, not persisted)
  scheduledTasksEnabled: boolean;
  sessionCronTasks: SessionCronTask[];

  // Teams (created this session — cleaned up on graceful shutdown)
  sessionCreatedTeams: Set<string>;

  // Skills (persist across compact; key is `${agentId}:${skillName}`)
  invokedSkills: Map<string, InvokedSkill>;

  // Slow operation tracking (for developer bar display)
  slowOperations: SlowOperation[];

  // In-memory error log
  inMemoryErrorLog: Array<{ error: unknown; timestamp: number }>;

  // Multi-model state (universal-agent exclusive)
  activeModelId: string | undefined;
  fallbackModelId: string | undefined;
  modelOverrideStack: string[];

  // Domain router state (universal-agent exclusive)
  activeDomain: string | undefined;
};

// ── Default state factory ─────────────────────────────────────────────────────

function createDefaultState(): State {
  const cwd = process.cwd();
  return {
    cwd,
    projectRoot: cwd,
    originalCwd: cwd,
    sessionId: newSessionId(),
    parentSessionId: undefined,

    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,

    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,

    startTime: Date.now(),
    lastInteractionTime: Date.now(),

    totalLinesAdded: 0,
    totalLinesRemoved: 0,

    hasUnknownModelCost: false,
    mainLoopModelOverride: undefined,

    isInteractive: true,
    isRemoteMode: false,
    strictToolResultPairing: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,

    flagSettingsPath: undefined,
    flagSettingsInline: null,

    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,

    scheduledTasksEnabled: false,
    sessionCronTasks: [],

    sessionCreatedTeams: new Set(),
    invokedSkills: new Map(),
    slowOperations: [],
    inMemoryErrorLog: [],

    activeModelId: undefined,
    fallbackModelId: undefined,
    modelOverrideStack: [],

    activeDomain: undefined,
  };
}

// ── Singleton state ───────────────────────────────────────────────────────────

let _state: State = createDefaultState();

// ── Getters ───────────────────────────────────────────────────────────────────

export function getSessionId(): SessionId {
  return _state.sessionId;
}

export function getParentSessionId(): SessionId | undefined {
  return _state.parentSessionId;
}

export function getCwd(): string {
  return _state.cwd;
}

export function getProjectRoot(): string {
  return _state.projectRoot;
}

export function getOriginalCwd(): string {
  return _state.originalCwd;
}

export function getTotalCostUSD(): number {
  return _state.totalCostUSD;
}

export function getStartTime(): number {
  return _state.startTime;
}

export function getLastInteractionTime(): number {
  return _state.lastInteractionTime;
}

export function isInteractive(): boolean {
  return _state.isInteractive;
}

export function isRemoteMode(): boolean {
  return _state.isRemoteMode;
}

export function getActiveModelId(): string | undefined {
  return _state.activeModelId;
}

export function getActiveDomain(): string | undefined {
  return _state.activeDomain;
}

export function getScheduledTasksEnabled(): boolean {
  return _state.scheduledTasksEnabled;
}

export function getSessionCronTasks(): SessionCronTask[] {
  return _state.sessionCronTasks;
}

export function getInvokedSkills(): Map<string, InvokedSkill> {
  return _state.invokedSkills;
}

export function getInvokedSkillsForAgent(agentId: string): InvokedSkill[] {
  const result: InvokedSkill[] = [];
  for (const [key, skill] of _state.invokedSkills) {
    if (key.startsWith(`${agentId}:`)) {
      result.push(skill);
    }
  }
  return result;
}

export function getSlowOperations(): SlowOperation[] {
  return _state.slowOperations;
}

export function getInMemoryErrorLog(): Array<{ error: unknown; timestamp: number }> {
  return _state.inMemoryErrorLog;
}

// ── Setters / mutators ────────────────────────────────────────────────────────

export function setCwd(cwd: string): void {
  _state.cwd = cwd;
}

export function setProjectRoot(root: string): void {
  _state.projectRoot = root;
}

export function setSessionId(id: SessionId): void {
  _state.sessionId = id;
}

export function setParentSessionId(id: SessionId | undefined): void {
  _state.parentSessionId = id;
}

export function setIsInteractive(v: boolean): void {
  _state.isInteractive = v;
}

export function setIsRemoteMode(v: boolean): void {
  _state.isRemoteMode = v;
}

export function setActiveModelId(id: string | undefined): void {
  _state.activeModelId = id;
}

export function setFallbackModelId(id: string | undefined): void {
  _state.fallbackModelId = id;
}

export function setActiveDomain(domain: string | undefined): void {
  _state.activeDomain = domain;
}

export function setScheduledTasksEnabled(v: boolean): void {
  _state.scheduledTasksEnabled = v;
}

export function setUserMsgOptIn(v: boolean): void {
  _state.userMsgOptIn = v;
}

export function setClientType(type: string): void {
  _state.clientType = type;
}

export function setMainLoopModelOverride(model: string | undefined): void {
  _state.mainLoopModelOverride = model;
}

export function setFlagSettingsPath(path: string | undefined): void {
  _state.flagSettingsPath = path;
}

export function setFlagSettingsInline(settings: Record<string, unknown> | null): void {
  _state.flagSettingsInline = settings;
}

// ── Accumulators ──────────────────────────────────────────────────────────────

export function addToTotalCost(usd: number): void {
  _state.totalCostUSD += usd;
}

export function addToAPIDuration(ms: number): void {
  _state.totalAPIDuration += ms;
}

export function addToToolDuration(ms: number): void {
  _state.totalToolDuration += ms;
}

export function addToLinesAdded(lines: number): void {
  _state.totalLinesAdded += lines;
}

export function addToLinesRemoved(lines: number): void {
  _state.totalLinesRemoved += lines;
}

export function updateLastInteractionTime(): void {
  _state.lastInteractionTime = Date.now();
}

export function markPostCompaction(): void {
  // Reset turn stats after compaction
  _state.turnHookDurationMs = 0;
  _state.turnToolDurationMs = 0;
  _state.turnToolCount = 0;
  _state.turnHookCount = 0;
}

// ── Cron task management ──────────────────────────────────────────────────────

export function addSessionCronTask(task: SessionCronTask): void {
  _state.sessionCronTasks.push(task);
}

export function removeSessionCronTask(id: string): void {
  _state.sessionCronTasks = _state.sessionCronTasks.filter(t => t.id !== id);
}

// ── Skill tracking ────────────────────────────────────────────────────────────

export function recordInvokedSkill(agentId: string, skill: Omit<InvokedSkill, 'agentId'>): void {
  const key = `${agentId}:${skill.skillName}`;
  _state.invokedSkills.set(key, { ...skill, agentId });
}

// ── Error logging ─────────────────────────────────────────────────────────────

export function logError(error: unknown): void {
  _state.inMemoryErrorLog.push({ error, timestamp: Date.now() });
  // Keep last 50 errors
  if (_state.inMemoryErrorLog.length > 50) {
    _state.inMemoryErrorLog.shift();
  }
}

// ── Team tracking ─────────────────────────────────────────────────────────────

export function addSessionCreatedTeam(name: string): void {
  _state.sessionCreatedTeams.add(name);
}

export function getSessionCreatedTeams(): Set<string> {
  return _state.sessionCreatedTeams;
}

// ── Slow operation tracking ───────────────────────────────────────────────────

export function recordSlowOperation(operation: string, durationMs: number): void {
  _state.slowOperations.push({ operation, durationMs, timestamp: Date.now() });
  // Keep last 20
  if (_state.slowOperations.length > 20) {
    _state.slowOperations.shift();
  }
}

// ── Reset (for tests / new sessions) ─────────────────────────────────────────

export function resetState(overrides?: Partial<State>): void {
  _state = { ...createDefaultState(), ...overrides };
}

// ── Full state access (for debugging / serialization) ─────────────────────────

export function getFullState(): Readonly<State> {
  return _state;
}
