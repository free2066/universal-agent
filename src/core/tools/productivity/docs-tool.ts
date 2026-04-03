/**
 * Docs Tools — Read, search, and fetch structured documents.
 *
 * Inspired by jarvis-cc's built-in Docs tool capability.
 * Three tools are provided:
 *
 *   1. ReadDoc   — Read a local document file (.md, .txt, .json, .csv, .rst, .yaml)
 *                  with optional section extraction and table-of-contents generation
 *
 *   2. DocSearch — Recursively search a directory for documents matching a keyword
 *                  Returns file paths + snippet matches for each hit
 *
 *   3. FetchDoc  — Fetch a document from a URL, optimised for structured content:
 *                  GitHub raw files, READMEs, API docs, knowledge-base articles
 *                  Supports Authorization header via DOCS_TOKEN env var
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { resolve, join, relative, extname, basename } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.yaml', '.yml', '.json', '.csv', '.toml', '.ini', '.conf', '.log']);
const MAX_DOC_CHARS = 40_000;   // ~10k tokens — safe ceiling for single doc read
const MAX_SEARCH_RESULTS = 20;
const MAX_SNIPPET_CHARS = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated — ${(text.length - max).toLocaleString()} chars remaining] ...`;
}

/** Extract a simple table of contents from Markdown headings */
function extractToc(content: string): string {
  const lines = content.split('\n');
  const headings = lines
    .filter((l) => /^#{1,4} /.test(l))
    .map((l) => {
      const depth = (l.match(/^#+/) ?? [''])[0].length;
      const title = l.replace(/^#+\s*/, '').trim();
      return `${'  '.repeat(depth - 1)}- ${title}`;
    });
  return headings.length > 0
    ? `Table of Contents:\n${headings.join('\n')}`
    : '(No headings found)';
}

/** Return the lines surrounding a keyword match as a snippet */
function extractSnippet(content: string, keyword: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 100);
  const end = Math.min(content.length, idx + keyword.length + 200);
  const snippet = content.slice(start, end).replace(/\n+/g, ' ');
  return (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : '');
}

// ── Tool 1: ReadDoc ───────────────────────────────────────────────────────────

export const readDocTool: ToolRegistration = {
  definition: {
    name: 'ReadDoc',
    description: [
      'Read a local document file and return its content.',
      'Supports: .md, .txt, .rst, .yaml, .yml, .json, .csv, .toml, .ini, .conf, .log',
      'Use format="toc" to get a table of contents from Markdown headings.',
      'Use format="sections" to split Markdown into named sections.',
      'Use max_chars to limit output length (default: 40000 characters).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the document file.',
        },
        format: {
          type: 'string',
          enum: ['text', 'toc', 'sections'],
          description: 'Output format: "text" (default) = raw content, "toc" = headings only, "sections" = split by headings',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 40000, ~10k tokens)',
        },
        start_section: {
          type: 'string',
          description: 'For format="sections": return only the section with this heading title',
        },
      },
      required: ['path'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const filePath = resolve(process.cwd(), String(args.path ?? ''));
    const format = String(args.format ?? 'text');
    const maxChars = Number(args.max_chars ?? MAX_DOC_CHARS);
    const startSection = args.start_section ? String(args.start_section) : undefined;

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return `Error: Path is a directory. Use DocSearch to list documents in a directory.`;
    }

    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext) && ext !== '') {
      return `Warning: File extension "${ext}" is not a known document type. Attempting to read as text.\n\n` +
        truncate(readFileSync(filePath, 'utf-8'), maxChars);
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }

    const meta = `File: ${filePath}\nSize: ${stat.size.toLocaleString()} bytes\n\n`;

    if (format === 'toc') {
      return meta + extractToc(content);
    }

    if (format === 'sections') {
      // Split by top-level or second-level Markdown headings
      const sections: Array<{ title: string; content: string }> = [];
      const lines = content.split('\n');
      let currentTitle = '(preamble)';
      let currentLines: string[] = [];

      for (const line of lines) {
        const headingMatch = line.match(/^(#{1,3}) (.+)/);
        if (headingMatch) {
          sections.push({ title: currentTitle, content: currentLines.join('\n').trim() });
          currentTitle = headingMatch[2].trim();
          currentLines = [line];
        } else {
          currentLines.push(line);
        }
      }
      sections.push({ title: currentTitle, content: currentLines.join('\n').trim() });

      if (startSection) {
        const target = sections.find((s) =>
          s.title.toLowerCase().includes(startSection.toLowerCase())
        );
        if (!target) {
          const titles = sections.map((s) => `  - ${s.title}`).join('\n');
          return `Section "${startSection}" not found.\nAvailable sections:\n${titles}`;
        }
        return meta + `## ${target.title}\n\n${truncate(target.content, maxChars)}`;
      }

      // Return summary of all sections
      const summary = sections
        .map((s) => `## ${s.title}\n${s.content.slice(0, 500)}${s.content.length > 500 ? '...' : ''}`)
        .join('\n\n---\n\n');
      return meta + truncate(summary, maxChars);
    }

    // Default: return raw text
    return meta + truncate(content, maxChars);
  },
};

// ── Tool 2: DocSearch ─────────────────────────────────────────────────────────

export const docSearchTool: ToolRegistration = {
  definition: {
    name: 'DocSearch',
    description: [
      'Recursively search a directory for documents containing a keyword.',
      'Returns matching file paths with relevant snippets.',
      'Supports filtering by file extension (e.g. [".md", ".txt"]).',
      'Useful for finding relevant documentation before reading it with ReadDoc.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory to search (absolute or relative path). Defaults to current working directory.',
        },
        query: {
          type: 'string',
          description: 'Keyword or phrase to search for (case-insensitive)',
        },
        file_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to include, e.g. [".md", ".txt"]. Defaults to all supported types.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
      },
      required: ['query'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const dir = resolve(process.cwd(), String(args.directory ?? '.'));
    const query = String(args.query ?? '');
    const maxResults = Number(args.max_results ?? MAX_SEARCH_RESULTS);
    const allowedExts = Array.isArray(args.file_types)
      ? new Set(args.file_types.map(String))
      : SUPPORTED_EXTENSIONS;

    if (!existsSync(dir)) {
      return `Error: Directory not found: ${dir}`;
    }
    if (!query) {
      return `Error: query parameter is required`;
    }

    // Collect all matching files recursively
    const candidates: string[] = [];
    const walk = (d: string, depth = 0) => {
      if (depth > 6) return; // safety limit
      try {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const fullPath = join(d, entry.name);
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          if (entry.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (allowedExts.has(ext)) candidates.push(fullPath);
          }
        }
      } catch { /* permission error — skip */ }
    };
    walk(dir);

    // Search for query in each file
    const results: Array<{ path: string; snippet: string; lineNumber: number }> = [];
    for (const filePath of candidates) {
      if (results.length >= maxResults) break;
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const lines = content.split('\n');
          const lineNumber = lines.findIndex((l) => l.toLowerCase().includes(query.toLowerCase())) + 1;
          const snippet = extractSnippet(content, query).slice(0, MAX_SNIPPET_CHARS);
          results.push({
            path: relative(dir, filePath),
            snippet,
            lineNumber,
          });
        }
      } catch { /* skip unreadable files */ }
    }

    if (results.length === 0) {
      return `No documents found matching "${query}" in ${dir}\n(Searched ${candidates.length} files)`;
    }

    const lines = [
      `Found ${results.length} document(s) matching "${query}" in ${dir}:`,
      `(Searched ${candidates.length} files)\n`,
    ];
    for (const r of results) {
      lines.push(`📄 ${r.path}  (line ${r.lineNumber})`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }
    lines.push(`\nTip: Use ReadDoc to read the full content of any of these files.`);

    return lines.join('\n');
  },
};

// ── Tool 3: FetchDoc ──────────────────────────────────────────────────────────

export const fetchDocTool: ToolRegistration = {
  definition: {
    name: 'FetchDoc',
    description: [
      'Fetch a document from a URL and return its text content.',
      'Optimised for: GitHub raw files, README pages, API documentation, knowledge-base articles.',
      'Automatically strips HTML tags and normalises whitespace.',
      'Set DOCS_TOKEN env var for authenticated requests (e.g. private GitHub repos).',
      'Supports GitHub shortcuts: "github:owner/repo/path/to/file.md" → fetches raw content.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the document to fetch. Supports "github:owner/repo/path" shorthand.',
        },
        format: {
          type: 'string',
          enum: ['text', 'toc', 'raw'],
          description: '"text" (default) = cleaned text, "toc" = headings only, "raw" = original response',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 40000)',
        },
        token_env: {
          type: 'string',
          description: 'Name of env var containing auth token (default: DOCS_TOKEN)',
        },
      },
      required: ['url'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    let url = String(args.url ?? '');
    const format = String(args.format ?? 'text');
    const maxChars = Number(args.max_chars ?? MAX_DOC_CHARS);
    const tokenEnv = String(args.token_env ?? 'DOCS_TOKEN');

    // GitHub shorthand: "github:owner/repo/path/to/file.md"
    if (url.startsWith('github:')) {
      const path = url.slice('github:'.length);
      url = `https://raw.githubusercontent.com/${path}`;
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    // Build headers
    const headers: Record<string, string> = {
      'User-Agent': 'universal-agent/1.0 (docs-tool)',
      'Accept': 'text/plain, text/html, application/json, */*',
    };
    const token = process.env[tokenEnv];
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let rawText: string;
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        return `Error fetching ${url}: HTTP ${res.status} ${res.statusText}`;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const body = await res.text();

      if (format === 'raw') return truncate(body, maxChars);

      if (contentType.includes('html')) {
        // Strip HTML tags
        rawText = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s{3,}/g, '\n\n')
          .trim();
      } else {
        rawText = body;
      }
    } catch (err) {
      return `Error fetching document: ${err instanceof Error ? err.message : String(err)}`;
    }

    const meta = `Source: ${url}\n\n`;

    if (format === 'toc') {
      return meta + extractToc(rawText);
    }

    return meta + truncate(rawText, maxChars);
  },
};
