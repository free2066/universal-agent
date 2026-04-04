/**
 * Async file utilities — non-blocking wrappers for common fs operations.
 *
 * Use these instead of readFileSync / writeFileSync / existsSync to avoid
 * blocking the Node.js event loop.  All functions use fs/promises internally.
 *
 * Relationship to existing utilities:
 *   - json.ts        — safe JSON parse helpers (safeJsonParse, etc.)
 *   - path-security.ts — CWE-22 path traversal guards (safeResolve, sanitizeName)
 *   - fs-async.ts    — THIS FILE: async I/O wrappers that compose with both
 *
 * Typical usage:
 *   import { readTextFile, readJsonFile, writeJsonFile } from '../../utils/fs-async.js';
 */

import { readFile, writeFile, stat, mkdir, rm } from 'fs/promises';
import { dirname } from 'path';
import { safeJsonParse, safeJsonParseObject, safeJsonParseArray } from './json.js';

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read a UTF-8 text file.
 * Returns `null` on ENOENT (file not found); throws on all other errors.
 *
 * @example
 *   const content = await readTextFile('/path/to/file.txt');
 *   if (content === null) { // file does not exist }
 */
export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read and parse a JSON file as type `T`.
 * Returns `fallback` if the file is missing or the JSON is invalid.
 * Optionally accepts a type-guard predicate for runtime validation.
 *
 * @example
 *   const cfg = await readJsonFile<Config>('/path/to/config.json', defaultConfig);
 */
export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
  guard?: (value: unknown) => boolean,
): Promise<T> {
  const content = await readTextFile(filePath);
  if (content === null) return fallback;
  return safeJsonParse<T>(content, fallback, guard);
}

/**
 * Read and parse a JSON file that is expected to be a plain object (not an
 * array or primitive).  Returns `fallback` on missing file or parse error.
 *
 * @example
 *   const data = await readJsonObjectFile<Record<string, unknown>>('/path/to/data.json', {});
 */
export async function readJsonObjectFile<T extends object>(
  filePath: string,
  fallback: T,
): Promise<T> {
  const content = await readTextFile(filePath);
  if (content === null) return fallback;
  return safeJsonParseObject<T>(content, fallback);
}

/**
 * Read and parse a JSON file that is expected to be an array.
 * Returns `fallback` (default `[]`) on missing file or parse error.
 *
 * @example
 *   const items = await readJsonArrayFile<string>('/path/to/list.json');
 */
export async function readJsonArrayFile<T>(
  filePath: string,
  fallback: T[] = [],
): Promise<T[]> {
  const content = await readTextFile(filePath);
  if (content === null) return fallback;
  return safeJsonParseArray<T>(content, fallback);
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Write UTF-8 text to a file, creating all ancestor directories as needed.
 * Uses atomic-style behaviour: no partial writes leak (writeFile is atomic on
 * most file systems for small files).
 *
 * @example
 *   await writeTextFile('/path/to/output.txt', 'hello world');
 */
export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Serialise `data` as JSON (2-space indent) and write it to `filePath`,
 * creating all ancestor directories as needed.
 *
 * @example
 *   await writeJsonFile('/path/to/config.json', { version: 1, items: [] });
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeTextFile(filePath, JSON.stringify(data, null, 2));
}

// ── Existence / deletion ─────────────────────────────────────────────────────

/**
 * Check whether a path exists (file or directory).
 * Always resolves to a boolean — never throws.
 *
 * @example
 *   if (await pathExists('/path/to/resource')) { ... }
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return file/directory stats, or `null` if the path does not exist.
 * Throws on permission errors or other unexpected I/O errors.
 *
 * @example
 *   const st = await statOrNull('/path/to/file');
 *   if (st?.isFile()) { ... }
 */
export async function statOrNull(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(targetPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it (and all ancestors) if necessary.
 * Equivalent to `mkdir -p`.
 *
 * @example
 *   await ensureDir('/path/to/new/directory');
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Remove a file or directory tree.
 * Silently ignores ENOENT (already gone); throws on other errors.
 *
 * @example
 *   await removePath('/path/to/temp-dir');
 */
export async function removePath(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
