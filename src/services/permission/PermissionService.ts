// @ts-nocheck
/**
 * G3: PermissionService — three-state (allow/deny/ask) rule-based permission
 * system for tool calls.
 *
 * Mirrors opencode's permission/index.ts:
 *   - Three-state actions: "allow" | "deny" | "ask"
 *   - Rules: { permission, pattern, action }
 *   - Wildcard pattern matching via minimatch
 *   - Persistence to ~/.uagent/permissions.json
 *
 * Storage:
 *   ~/.uagent/permissions.json
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { minimatch } from 'minimatch'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { HOME_DIR } from '../../utils/env.js'

// ──────────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────────

/** Three-state permission decision */
export type PermissionAction = 'allow' | 'deny' | 'ask'

/**
 * A single permission rule.
 *
 * @example
 * { permission: 'bash', pattern: 'rm -rf *', action: 'deny' }
 * { permission: 'file:write', pattern: '/etc/**', action: 'ask' }
 * { permission: 'network', pattern: '**', action: 'allow' }
 */
export interface PermissionRule {
  /** Unique rule id (auto-generated if not supplied) */
  id: string
  /** Tool/permission category, e.g. "bash", "file:write", "network" */
  permission: string
  /**
   * Glob pattern matched against the tool argument.
   * Uses minimatch semantics. "*" matches everything in a single segment;
   * "**" matches across path separators.
   */
  pattern: string
  /** Resulting action when the rule matches */
  action: PermissionAction
}

export interface PermissionRequest {
  id: string
  permission: string
  /** One or more values to check (e.g. file paths, command strings) */
  patterns: string[]
  metadata?: Record<string, unknown>
}

// ──────────────────────────────────────────────────────────────────────────────
//  PermissionService
// ──────────────────────────────────────────────────────────────────────────────

const PERMISSIONS_FILE = path.join(HOME_DIR, '.uagent', 'permissions.json')

export class PermissionService {
  private rules: PermissionRule[] = []
  private loaded = false

  // ── Rule management ────────────────────────────────────────────────────────

  /** Add a rule. Auto-generates an id if not set. */
  addRule(rule: Omit<PermissionRule, 'id'> & { id?: string }): PermissionRule {
    const full: PermissionRule = {
      id: rule.id ?? crypto.randomUUID().slice(0, 8),
      ...rule,
    }
    this.rules.push(full)
    return full
  }

  /** Remove a rule by id. No-op if not found. */
  removeRule(id: string): boolean {
    const before = this.rules.length
    this.rules = this.rules.filter(r => r.id !== id)
    return this.rules.length < before
  }

  /** Return a copy of all current rules. */
  listRules(): PermissionRule[] {
    return [...this.rules]
  }

  /** Remove all rules. */
  clearRules(): void {
    this.rules = []
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate a permission check.
   *
   * Rules are checked in order; the first match wins.
   * If no rule matches, returns "ask" (safe default — prompt the user).
   *
   * @param permission  The tool category (e.g. "bash")
   * @param value       The value to check (e.g. "rm -rf /")
   */
  evaluate(permission: string, value: string): PermissionAction {
    for (const rule of this.rules) {
      if (rule.permission !== permission && rule.permission !== '*') continue
      if (minimatch(value, rule.pattern, { dot: true, nocase: false })) {
        return rule.action
      }
    }
    return 'ask'
  }

  /**
   * Evaluate a PermissionRequest — checks all patterns and returns the most
   * restrictive action found ("deny" > "ask" > "allow").
   */
  evaluateRequest(req: PermissionRequest): PermissionAction {
    const results = req.patterns.map(p => this.evaluate(req.permission, p))
    const resultSet = new Set(results)
    if (resultSet.has('deny')) return 'deny'
    if (resultSet.has('ask')) return 'ask'
    return 'allow'
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /** Persist current rules to ~/.uagent/permissions.json. */
  saveRules(): void {
    const dir = path.dirname(PERMISSIONS_FILE)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({ rules: this.rules }, null, 2)
    fs.writeFileSync(PERMISSIONS_FILE, payload, 'utf-8')
  }

  /** Load rules from ~/.uagent/permissions.json (idempotent). */
  loadRules(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.rules)) {
        this.rules = parsed.rules as PermissionRule[]
        return
      }

      logForDebugging(
        `[PermissionService] Ignoring invalid rules payload in ${PERMISSIONS_FILE}`,
        { level: 'warn' },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return
      }

      logForDebugging(
        `[PermissionService] Failed to load rules from ${PERMISSIONS_FILE}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  /** Reset loaded state (useful for tests). */
  reset(): void {
    this.rules = []
    this.loaded = false
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Singleton
// ──────────────────────────────────────────────────────────────────────────────

let _instance: PermissionService | null = null

/** Get (or create) the process-level singleton PermissionService. */
export function getPermissionService(): PermissionService {
  if (!_instance) {
    _instance = new PermissionService()
    _instance.loadRules()
  }
  return _instance
}
