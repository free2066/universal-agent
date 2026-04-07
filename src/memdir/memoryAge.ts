/**
 * memdir/memoryAge.ts — Memory time-to-live management
 *
 * Mirrors claude-code's memdir/memoryAge.ts.
 * Provides age-based TTL management for memory items.
 */

import type { MemoryItem } from './memoryTypes.js';

/** Default TTLs in ms */
export const TTL = {
  pinned: Infinity,
  insight: 30 * 24 * 60 * 60 * 1000,   // 30 days
  fact:     7 * 24 * 60 * 60 * 1000,   // 7 days
  iteration: 90 * 24 * 60 * 60 * 1000, // 90 days
};

/**
 * Check if a memory item has expired.
 */
export function isExpired(item: MemoryItem): boolean {
  if (item.ttl === undefined) return false;
  return Date.now() > item.ttl;
}

/**
 * Get the age of a memory item in ms.
 */
export function getAgeMs(item: MemoryItem): number {
  return Date.now() - item.createdAt;
}

/**
 * Get a human-readable age string.
 */
export function formatAge(item: MemoryItem): string {
  const ms = getAgeMs(item);
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/**
 * Get the default TTL for a memory type.
 */
export function getDefaultTtl(type: MemoryItem['type']): number | undefined {
  const ttl = TTL[type];
  if (ttl === Infinity) return undefined;
  return Date.now() + ttl;
}
