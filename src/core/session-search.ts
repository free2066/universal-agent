/**
 * session-search.ts -- LLM-powered semantic session search
 *
 * B25: agenticSessionSearch -- upgrade /search from keyword matching to LLM semantic ranking.
 *   Mirrors claude-code src/utils/agenticSessionSearch.ts L146-308 (agenticSessionSearch()).
 *
 * Two-phase strategy:
 *   Phase 1: keyword pre-filter over session metadata (title/firstPrompt) -- fast, no LLM cost
 *   Phase 2: LLM semantic ranking of candidates (up to 100) using compact model
 *
 * Fallback: if LLM fails or candidates <= 3, returns keyword-filtered results directly.
 */

import { listAllSnapshots, searchSnapshots, type SearchResult } from './memory/session-snapshot.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgenticSearchResult {
  sessionId: string;
  savedAt: number;
  displayTitle?: string;
  firstPrompt?: string;
  relevanceScore?: number;    // optional, set if LLM ranking succeeded
  snippets?: SearchResult[];  // keyword-matched snippets from the session
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * B25: agenticSessionSearch -- LLM semantic session search.
 *
 * @param query       Natural language search query
 * @param maxResults  Maximum number of sessions to return (default 10)
 * @param cwd         Optional working directory for project-specific sessions
 *
 * Mirrors claude-code agenticSessionSearch.ts L146 agenticSessionSearch().
 */
export async function agenticSessionSearch(
  query: string,
  maxResults = 10,
  cwd?: string,
): Promise<AgenticSearchResult[]> {
  if (!query.trim()) return [];

  // Phase 1: load all session metadata (cheap, no LLM)
  // listAllSnapshots returns at most ~200 entries with lite metadata
  const allMeta = listAllSnapshots(200, cwd);
  if (allMeta.length === 0) return [];

  // Phase 1 keyword pre-filter: keep sessions whose metadata matches any keyword
  const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length >= 2);
  const candidates =
    keywords.length === 0
      ? allMeta
      : allMeta.filter((s) => {
          const text = [s.displayTitle, s.firstPrompt].filter(Boolean).join(' ').toLowerCase();
          return keywords.some((kw) => text.includes(kw));
        });

  // If very few candidates, skip LLM -- not worth the cost
  if (candidates.length <= 3) {
    // Still run keyword search for snippets
    return candidates.slice(0, maxResults).map((s) => ({
      sessionId: s.sessionId,
      savedAt: s.savedAt,
      displayTitle: s.displayTitle,
      firstPrompt: s.firstPrompt,
      snippets: searchSnapshots(query, 3, cwd).filter((r) => r.sessionId === s.sessionId),
    }));
  }

  // Phase 2: LLM semantic ranking
  try {
    const rankedIndices = await _rankWithLLM(query, candidates.slice(0, 100));

    // Map ranked indices back to candidates
    const ranked = rankedIndices
      .filter((i) => i >= 0 && i < candidates.length)
      .map((i, rank) => {
        const s = candidates[i]!;
        return {
          sessionId: s.sessionId,
          savedAt: s.savedAt,
          displayTitle: s.displayTitle,
          firstPrompt: s.firstPrompt,
          relevanceScore: 1 - rank / rankedIndices.length,
          snippets: [] as import('./memory/session-snapshot.js').SearchResult[],
        };
      })
      .slice(0, maxResults);

    // Attach keyword snippets for top results
    const keywordResults = searchSnapshots(query, maxResults * 2, cwd);
    for (const result of ranked) {
      result.snippets = keywordResults.filter((r) => r.sessionId === result.sessionId).slice(0, 3);
    }

    return ranked;
  } catch {
    // Fallback: return keyword pre-filtered candidates sorted by recency
    const fallback = candidates.slice(0, maxResults).map((s) => ({
      sessionId: s.sessionId,
      savedAt: s.savedAt,
      displayTitle: s.displayTitle,
      firstPrompt: s.firstPrompt,
      snippets: searchSnapshots(query, 3, cwd).filter((r) => r.sessionId === s.sessionId),
    }));
    return fallback;
  }
}

// ── LLM ranking helper ─────────────────────────────────────────────────────────

/**
 * B25: _rankWithLLM -- ask compact LLM to rank sessions by relevance.
 *
 * Sends a structured list of session metadata to the LLM and asks it to return
 * relevant session indices in order of relevance.
 *
 * Returns array of indices into candidates (0-based), most relevant first.
 * Mirrors claude-code agenticSessionSearch.ts L210-L290 LLM invocation.
 */
async function _rankWithLLM(
  query: string,
  candidates: Array<{
    sessionId: string;
    savedAt: number;
    displayTitle?: string;
    firstPrompt?: string;
  }>,
): Promise<number[]> {
  const { modelManager } = await import('../models/model-manager.js');
  const client = modelManager.getClient('compact');

  // Build compact session list for LLM
  const sessionList = candidates.map((s, i) => ({
    index: i,
    title: s.displayTitle ?? '(untitled)',
    firstPrompt: (s.firstPrompt ?? '').slice(0, 200),
    savedAt: new Date(s.savedAt).toISOString().slice(0, 10),
  }));

  const systemPrompt =
    'You are a session search assistant. Given a search query and a list of conversation ' +
    'sessions (with title, first message, and date), identify which sessions are most relevant ' +
    'to the query. Return a JSON object with a "relevant_indices" array containing the 0-based ' +
    'indices of relevant sessions, ordered by relevance (most relevant first). ' +
    'Only include sessions that are genuinely relevant. Return ONLY the JSON object, nothing else. ' +
    'Example: {"relevant_indices": [2, 0, 5]}';

  const userContent =
    `Search query: "${query}"\n\n` +
    `Sessions:\n${JSON.stringify(sessionList, null, 2)}\n\n` +
    `Return the relevant session indices as JSON:`;

  const response = await client.chat({
    systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    // A25: skip cache write since this is a fork/fire-and-forget query
    skipCacheWrite: true,
  });

  // Parse LLM response
  const raw = response.content.trim();
  // Extract JSON from response (may have markdown fencing)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]) as { relevant_indices?: unknown };
  if (!Array.isArray(parsed.relevant_indices)) return [];

  return (parsed.relevant_indices as unknown[])
    .filter((i): i is number => typeof i === 'number' && i >= 0 && i < candidates.length);
}
