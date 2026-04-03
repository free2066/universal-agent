/**
 * MemoryStore — Long-term memory for universal-agent
 *
 * Inspired by mem9's architecture and Cowork Forge's 4-type memory system
 * (kstack article #15345 "我组建了一个虚拟产研团队，7个成员全是AI"):
 *
 * Memory types:
 *   - pinned:    permanent user-specified rules / preferences
 *   - insight:   LLM-extracted project knowledge (Smart Ingest)
 *   - fact:      short-lived context facts (default 7-day TTL)
 *   - iteration: task retrospective snapshots — what was done, problems found,
 *                tech debt created (inspired by Cowork Forge's "迭代知识记忆").
 *                Survives 90 days. Max 50 entries per project.
 *                Retrieved via getRecentIterations() for system prompt injection.
 *
 * Storage: ~/.uagent/memory/<project-hash>/{pinned,insight,fact,iteration}.jsonl
 * No external dependencies — pure Node.js file I/O.
 */

import {
  existsSync, mkdirSync,
  readFileSync, writeFileSync,
} from 'fs';
import { resolve, join } from 'path';
import { createHash } from 'crypto';

import { modelManager } from '../../models/model-manager.js';
import { rankMemories } from './memory-search.js';
import type { Message, ToolRegistration } from '../../models/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryType = 'pinned' | 'insight' | 'fact' | 'iteration';
export type MemorySource = 'user' | 'agent' | 'ingest';

export interface MemoryItem {
  id: string;
  type: MemoryType;
  content: string;
  project: string;       // absolute project root path
  tags: string[];
  source: MemorySource;
  createdAt: number;     // Unix ms
  updatedAt: number;     // Unix ms
  accessCount: number;   // recall hit counter
  ttl?: number;          // optional expiry timestamp (ms)
}

export interface RecallOptions {
  project?: string;
  types?: MemoryType[];
  limit?: number;
}

export interface IngestResult {
  added: number;
  updated: number;
  skipped: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(process.env.HOME ?? '~', '.uagent');
const MEMORY_ROOT = join(CONFIG_DIR, 'memory');

/** Maximum memories per type per project */
const MAX_PER_TYPE: Record<MemoryType, number> = {
  pinned:    500,
  insight:   200,
  fact:      300,
  iteration:  50,  // keep last 50 task retrospectives per project
};

/** Default TTL for fact memories: 7 days */
const FACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default TTL for iteration snapshots: 90 days (longer-lived project knowledge) */
export const ITERATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Minimum content-similarity threshold for LWW dedup (0-1) */
const DEDUP_THRESHOLD = 0.8;

// ─── ID Generation ───────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 12);
}

// ─── Project Hashing ─────────────────────────────────────────────────────────

function projectHash(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

// ─── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore {
  private readonly project: string;
  private readonly dir: string;

  // In-memory cache per type (loaded lazily)
  private cache: Map<MemoryType, MemoryItem[]> = new Map();
  private cacheLoaded: Set<MemoryType> = new Set();

  constructor(projectRoot?: string) {
    this.project = resolve(projectRoot ?? process.cwd());
    this.dir = join(MEMORY_ROOT, projectHash(this.project));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  // ── Private: File Paths ───────────────────────────────────────────────────

  private filePath(type: MemoryType): string {
    return join(this.dir, `${type}.jsonl`);
  }

  // ── Private: Load / Save ─────────────────────────────────────────────────

  private load(type: MemoryType): MemoryItem[] {
    if (this.cacheLoaded.has(type)) {
      return this.cache.get(type) ?? [];
    }

    const file = this.filePath(type);
    const items: MemoryItem[] = [];

    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line) as MemoryItem;
          if (item.project === this.project) items.push(item);
        } catch { /* skip malformed */ }
      }
    }

    this.cache.set(type, items);
    this.cacheLoaded.add(type);
    return items;
  }

  private save(type: MemoryType): void {
    const items = this.cache.get(type) ?? [];
    const content = items.map((i) => JSON.stringify(i)).join('\n');
    writeFileSync(this.filePath(type), content ? content + '\n' : '', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Add a new memory item.
   * Returns the created item's id.
   */
  add(input: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'project'>): string {
    const items = this.load(input.type);
    const now = Date.now();
    const item: MemoryItem = {
      ...input,
      id: generateId(),
      project: this.project,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      ttl: input.type === 'fact' && !input.ttl
        ? now + FACT_TTL_MS
        : input.type === 'iteration' && !input.ttl
          ? now + ITERATION_TTL_MS
          : input.ttl,
    };
    items.push(item);
    this.trimToLimit(items, input.type);
    this.save(input.type);
    return item.id;
  }

  /**
   * Get a single memory item by id.
   */
  get(id: string): MemoryItem | undefined {
    for (const type of (['pinned', 'insight', 'fact', 'iteration'] as MemoryType[])) {
      const found = this.load(type).find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Delete a memory item by id.
   * Returns true if found and deleted.
   */
  delete(id: string): boolean {
    for (const type of (['pinned', 'insight', 'fact', 'iteration'] as MemoryType[])) {
      const items = this.load(type);
      const idx = items.findIndex((m) => m.id === id);
      if (idx !== -1) {
        items.splice(idx, 1);
        this.save(type);
        return true;
      }
    }
    return false;
  }

  /**
   * List memories for this project, optionally filtered by type.
   */
  list(options: { types?: MemoryType[] } = {}): MemoryItem[] {
    const types = options.types ?? ['pinned', 'insight', 'fact', 'iteration'];
    return types.flatMap((t) => this.load(t));
  }

  /**
   * Update a memory item's content and tags.
   */
  update(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'tags' | 'ttl'>>): boolean {
    for (const type of (['pinned', 'insight', 'fact', 'iteration'] as MemoryType[])) {
      const items = this.load(type);
      const item = items.find((m) => m.id === id);
      if (item) {
        Object.assign(item, patch, { updatedAt: Date.now() });
        this.save(type);
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all memories for this project.
   */
  clear(types?: MemoryType[]): void {
    const target = types ?? (['pinned', 'insight', 'fact', 'iteration'] as MemoryType[]);
    for (const type of target) {
      this.cache.set(type, []);
      this.cacheLoaded.add(type);
      this.save(type);
    }
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * Recall memories relevant to `query`.
   *
   * Algorithm:
   *   1. Always include all `pinned` items (they are project-wide rules)
   *   2. Rank insight/fact items via hybrid retrieval:
   *        TF-IDF (sparse) + Semantic Embedding (dense) → 3-way RRF → time decay
   *      Embedding auto-selects provider: OpenAI/Gemini (if key) → local n-gram (fallback)
   *   3. Always inject most recent 3 `iteration` snapshots (time-sorted, no ranking)
   *   4. Return pinned + top-K ranked + recent iterations
   *
   * Now async to support embedding-based semantic retrieval.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<MemoryItem[]> {
    const { types, limit = 8 } = options;

    // Always load pinned
    const pinned = this.load('pinned');

    // Rank insight/fact by hybrid relevance (TF-IDF + semantic embedding)
    const rankable: MemoryItem[] = [];
    for (const type of (['insight', 'fact'] as MemoryType[])) {
      if (!types || types.includes(type)) {
        rankable.push(...this.load(type));
      }
    }
    // rankMemories is now async — embedding may call API or local n-gram
    const ranked = (await rankMemories(query, rankable, limit)).map((r) => r.item);

    // Always inject recent iteration snapshots (last 3, time-sorted descending)
    // Inspired by Cowork Forge's "迭代知识记忆" — cross-session project knowledge
    const recentIterations = (!types || types.includes('iteration'))
      ? this.getRecentIterations(3)
      : [];

    // Bump access count for recalled items (for LRU stats)
    const recalled = [...pinned, ...ranked, ...recentIterations];
    for (const item of recalled) {
      item.accessCount += 1;
      item.updatedAt = Date.now();
    }
    // Persist updated access counts lazily — but only if something actually changed
    if (recalled.length > 0) {
      for (const type of (['pinned', 'insight', 'fact', 'iteration'] as MemoryType[])) {
        if (this.cacheLoaded.has(type) && (this.cache.get(type) ?? []).some((m) => recalled.includes(m))) {
          this.save(type);
        }
      }
    }

    return recalled;
  }

  /**
   * Get the most recent iteration snapshots for this project.
   * Returns items sorted by creation time (newest first).
   *
   * Used by:
   *   - recall() to inject recent iterations into system prompt automatically
   *   - agent.ts to display iteration history in context
   *
   * Inspired by Cowork Forge's 4-layer memory system:
   * "迭代知识记忆" — captures what was done, problems found, tech debt created.
   */
  getRecentIterations(limit = 5): MemoryItem[] {
    return this.load('iteration')
      .filter((m) => !m.ttl || m.ttl > Date.now()) // exclude expired
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // ── Smart Ingest ──────────────────────────────────────────────────────────

  /**
   * Smart Ingest: ask the LLM to extract valuable memories from a conversation.
   *
   * Follows mem9's two-phase approach:
   *   Phase 1: extract atomic facts / insights
   *   Phase 2: dedup against existing memories (LWW if similarity > threshold)
   */
  async ingest(conversation: Message[]): Promise<IngestResult> {
    if (conversation.length < 2) return { added: 0, updated: 0, skipped: 0 };

    // Build conversation text (last 30 turns to stay within context)
    const recentTurns = conversation.slice(-30);
    const convText = recentTurns
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 500)}`)
      .join('\n');

    // ── 6 categories that should NOT be saved (Claude Code memory system, kstack #15375) ──
    // These are explicitly excluded to prevent memory pollution and avoid redundancy with
    // information already available in code, git history, or AGENTS.md.
    const prompt = `Analyze this conversation and extract information worth remembering long-term.
Focus on:
1. Project architecture decisions and conventions
2. User preferences and coding style
3. Important bugs discovered and how they were fixed
4. Reusable patterns or domain knowledge

Return a JSON array (ONLY the array, no explanation):
[{ "type": "insight" | "fact", "content": "concise memory text", "tags": ["tag1", "tag2"] }]

Rules:
- Max 10 items total
- Each content should be self-contained (readable without the conversation)
- Tags should be 1-3 lowercase keywords
- DO NOT save any of these 6 categories (they pollute memory or duplicate existing info):
  1. Code patterns — code is already in the repo; don't duplicate it as text
  2. Git history — use git log instead
  3. Debugging steps — one-off steps have no lasting value
  4. AGENTS.md content — already loaded separately into every system prompt
  5. Temporary task details — ephemeral work not worth remembering
  6. Small talk, greetings, and meta-commentary about the AI assistant itself

Conversation:
${convText}`;

    let extracted: Array<{ type: MemoryType; content: string; tags: string[] }> = [];
    try {
      const client = modelManager.getClient('compact');
      const response = await client.chat({
        systemPrompt: 'You are a memory extraction assistant. Return only valid JSON arrays.',
        messages: [{ role: 'user', content: prompt }],
      });
      const rawContent = response.content.trim();
      // Extract JSON array from response (may be wrapped in markdown code block)
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Ingest failure is non-fatal
      return { added: 0, updated: 0, skipped: 0 };
    }

    if (!Array.isArray(extracted)) return { added: 0, updated: 0, skipped: 0 };

    const result: IngestResult = { added: 0, updated: 0, skipped: 0 };

    for (const entry of extracted) {
      if (!entry.content || typeof entry.content !== 'string') continue;
      const type = entry.type === 'fact' ? 'fact' : 'insight';
      const tags = Array.isArray(entry.tags) ? entry.tags.slice(0, 5) : [];

      // LWW dedup: check if similar insight already exists
      const existing = this.load(type);
      const duplicate = existing.find((m) => this.similarity(m.content, entry.content) >= DEDUP_THRESHOLD);

      if (duplicate) {
        // Last Write Wins: update content if newer insight is better
        if (entry.content.length > duplicate.content.length * 0.8) {
          this.update(duplicate.id, { content: entry.content, tags });
          result.updated++;
        } else {
          result.skipped++;
        }
      } else {
        this.add({ type, content: entry.content, tags, source: 'ingest' });
        result.added++;
      }
    }

    return result;
  }

  // ── GC ───────────────────────────────────────────────────────────────────

  /**
   * Garbage collect expired memories and prune over-limit entries.
   * Returns count of removed items.
   */
  gc(): number {
    let removed = 0;
    const now = Date.now();

    // Remove expired fact + iteration memories
    for (const type of (['fact', 'iteration'] as MemoryType[])) {
      const items = this.load(type);
      const valid = items.filter((m) => {
        if (m.ttl && m.ttl < now) { removed++; return false; }
        return true;
      });
      if (valid.length !== items.length) {
        this.cache.set(type, valid);
        this.save(type);
      }
    }

    // Prune over-limit entries (remove least-accessed)
    for (const type of (['insight', 'fact', 'iteration'] as MemoryType[])) {
      const items = this.load(type);
      const max = MAX_PER_TYPE[type];
      if (items.length > max) {
        // For iteration: keep newest N (time-sorted) rather than most-accessed
        const sorted = type === 'iteration'
          ? [...items].sort((a, b) => b.createdAt - a.createdAt)
          : [...items].sort((a, b) => b.accessCount - a.accessCount);
        const pruned = sorted.slice(max);
        removed += pruned.length;
        this.cache.set(type, sorted.slice(0, max));
        this.save(type);
      }
    }

    return removed;
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  stats(): { pinned: number; insight: number; fact: number; iteration: number; total: number } {
    const pinned = this.load('pinned').length;
    const insight = this.load('insight').length;
    const fact = this.load('fact').length;
    const iteration = this.load('iteration').length;
    return { pinned, insight, fact, iteration, total: pinned + insight + fact + iteration };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /** Simple character-level Jaccard similarity for LWW dedup */
  private similarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/));
    const setA = tokenize(a);
    const setB = tokenize(b);
    const intersection = [...setA].filter((x) => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /** Trim items array to the per-type limit (remove least recently used) */
  private trimToLimit(items: MemoryItem[], type: MemoryType): void {
    const max = MAX_PER_TYPE[type];
    if (items.length > max) {
      // Sort by access count asc, then remove oldest low-access items
      items.sort((a, b) => a.accessCount - b.accessCount || a.updatedAt - b.updatedAt);
      items.splice(0, items.length - max);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

// Key: resolved project path → MemoryStore instance
// Using a Map instead of a single variable so switching projects within
// the same process (e.g. multi-repo sessions) gets the correct store.
const _storeCache = new Map<string, MemoryStore>();

/**
 * Get the MemoryStore for the given project root (or cwd).
 * Returns the same instance for repeated calls with the same root.
 * Call `resetMemoryStore()` in tests to clear the cache.
 */
export function getMemoryStore(projectRoot?: string): MemoryStore {
  const key = resolve(projectRoot ?? process.cwd());
  let store = _storeCache.get(key);
  if (!store) {
    store = new MemoryStore(key);
    _storeCache.set(key, store);
  }
  return store;
}

export function resetMemoryStore(): void {
  _storeCache.clear();
}
