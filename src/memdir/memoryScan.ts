/**
 * memdir/memoryScan.ts — Memory directory scanning
 *
 * Mirrors claude-code's memdir/memoryScan.ts.
 * Provides utilities for scanning memory directories.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectMemDir } from './paths.js';
import type { MemoryItem } from './memoryTypes.js';

/**
 * Scan all memory files for a given project root.
 * Returns all valid memory items (skips malformed entries).
 */
export function scanProjectMemory(projectRoot: string): MemoryItem[] {
  const memDir = getProjectMemDir(projectRoot);
  if (!existsSync(memDir)) return [];

  const items: MemoryItem[] = [];
  const files = readdirSync(memDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = join(memDir, file);
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line) as MemoryItem;
          if (item.id && item.content && item.type) {
            items.push(item);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  return items;
}

/**
 * Count memory items by type for a given project.
 */
export function countMemoryByType(projectRoot: string): Record<string, number> {
  const items = scanProjectMemory(projectRoot);
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}
