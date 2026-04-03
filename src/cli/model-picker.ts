/**
 * model-picker.ts — Interactive /model picker UI
 *
 * Renders a full-screen terminal UI similar to the screenshot:
 *   - "Select Model" header
 *   - Current model shown
 *   - Recent section (last 5 used)
 *   - Provider-grouped list (万擎 / OpenRouter / Groq / …)
 *   - Keyboard: ↑↓ navigate, Enter select, ESC cancel, /: search, ←→ page
 *
 * Uses raw stdin mode for full keyboard control (no external deps beyond chalk).
 */

import chalk from 'chalk';

/**
 * Built-in friendly name map.
 * Keys are substrings / exact model IDs (matched case-insensitively).
 * Order matters: more specific entries should come first.
 */
const FRIENDLY_NAMES: Array<[RegExp, string]> = [
  // Claude
  [/claude-opus-4/i,              'Claude Opus 4'],
  [/claude-sonnet-4[-.]6/i,       'Claude Sonnet 4.6'],
  [/claude-sonnet-4[-.]5/i,       'Claude Sonnet 4.5 (Preview)'],
  [/claude-3[-.]7-sonnet/i,       'Claude Sonnet 3.7'],
  [/claude-3[-.]5-sonnet/i,       'Claude Sonnet 3.5'],
  [/claude-haiku-4[-.]5/i,        'Claude Haiku 4.5'],
  [/claude-3[-.]5-haiku/i,        'Claude Haiku 3.5'],
  [/claude-3-haiku/i,             'Claude Haiku 3'],
  [/claude-3-opus/i,              'Claude Opus 3'],
  // Gemini
  [/gemini-2\.5-pro/i,            'Gemini 2.5 Pro'],
  [/gemini-2\.0-flash-thinking/i, 'Gemini 2.0 Flash Thinking'],
  [/gemini-2\.0-flash/i,          'Gemini 2.0 Flash'],
  [/gemini-1\.5-pro/i,            'Gemini 1.5 Pro'],
  [/gemini-1\.5-flash/i,          'Gemini 1.5 Flash'],
  [/gemma-3-27b/i,                'Gemma 3 27B'],
  [/gemma-3-12b/i,                'Gemma 3 12B'],
  [/lyria-3/i,                    'Lyria 3'],
  // GPT / OpenAI
  [/gpt-4\.1-mini/i,              'GPT-4.1 Mini'],
  [/gpt-4\.1-nano/i,              'GPT-4.1 Nano'],
  [/gpt-4\.1/i,                   'GPT-4.1'],
  [/gpt-4o-mini/i,                'GPT-4o Mini'],
  [/gpt-4o/i,                     'GPT-4o'],
  [/o4-mini/i,                    'o4 Mini'],
  [/o3-mini/i,                    'o3 Mini'],
  [/o3/i,                         'o3'],
  [/o1-mini/i,                    'o1 Mini'],
  [/o1/i,                         'o1'],
  // DeepSeek
  [/deepseek-r2/i,                'DeepSeek R2'],
  [/deepseek-r1-zero/i,           'DeepSeek R1 Zero'],
  [/deepseek-r1/i,                'DeepSeek R1'],
  [/deepseek-v3/i,                'DeepSeek V3'],
  [/deepseek-v2\.5/i,             'DeepSeek V2.5'],
  // Llama
  [/llama-3\.3-70b/i,             'Llama 3.3 70B'],
  [/llama-3\.1-405b/i,            'Llama 3.1 405B'],
  [/llama-3\.1-70b/i,             'Llama 3.1 70B'],
  [/llama-3\.1-8b/i,              'Llama 3.1 8B'],
  // Qwen
  [/qwen3-235b/i,                 'Qwen3 235B'],
  [/qwen3-30b/i,                  'Qwen3 30B'],
  [/qwen3-8b/i,                   'Qwen3 8B'],
  [/qwen-2\.5-72b/i,              'Qwen 2.5 72B'],
  [/qwen-2\.5-7b/i,               'Qwen 2.5 7B'],
  // Mistral / Mixtral
  [/mistral-large/i,              'Mistral Large'],
  [/mistral-small/i,              'Mistral Small'],
  [/mixtral-8x22b/i,              'Mixtral 8x22B'],
  [/mixtral-8x7b/i,               'Mixtral 8x7B'],
  // GLM (万擎 default)
  [/glm-5/i,                      'GLM-5'],
  [/glm-4\.5/i,                   'GLM-4.5'],
  [/glm-4/i,                      'GLM-4'],
  // Groq fast models
  [/moonshotai\/moonlight/i,      'Moonlight'],
  [/kimi-k2/i,                    'Kimi K2'],
  // SiliconFlow
  [/internlm3-8b/i,               'InternLM3 8B'],
];

/**
 * Convert a raw model ID to a human-readable display name.
 * Falls back to a cleaned-up version of the ID itself.
 */
export function friendlyName(rawId: string): string {
  // Strip common prefixes for matching
  const bare = rawId.replace(/^openrouter:|^groq:|^siliconflow:|^ollama:/, '');
  for (const [pattern, name] of FRIENDLY_NAMES) {
    if (pattern.test(bare)) return name;
  }
  // Fallback: strip prefix, title-case path segments
  return bare
    .split('/').pop()!                     // last path segment
    .replace(/:free$/, '')                 // remove :free suffix
    .replace(/[-_]/g, ' ')                 // hyphens/underscores → spaces
    .replace(/\b\w/g, c => c.toUpperCase()) // title-case
    .trim() || rawId;
}

export interface ModelItem {
  id: string;          // model ID used by the system (e.g. ep-xxx, openrouter:foo)
  label: string;       // human-readable name (e.g. "Claude Sonnet 4.6")
  provider: string;    // group label (e.g. "万擎", "OpenRouter", "Groq")
  detail?: string;     // shown in gray after → (raw model id)
}

interface PickerResult {
  selected: string | null;  // null = cancelled
}

const PAGE_SIZE = 10;
const RECENT_KEY = '__recent__';

/** Build display items from available models and recent history */
function buildItems(
  available: ModelItem[],
  current: string,
  recentIds: string[],
): { items: ModelItem[]; separators: Set<number> } {
  const items: ModelItem[] = [];
  const separators = new Set<number>();

  // Recent section
  const recentItems = recentIds
    .filter((id) => id !== current)
    .slice(0, 5)
    .map((id) => available.find((m) => m.id === id))
    .filter(Boolean) as ModelItem[];

  if (recentItems.length > 0) {
    items.push(...recentItems.map((m) => ({ ...m, provider: RECENT_KEY })));
    separators.add(items.length); // separator after recent
  }

  // Group remaining by provider
  const providers = [...new Set(available.map((m) => m.provider))];
  for (const provider of providers) {
    const group = available.filter((m) => m.provider === provider);
    items.push(...group);
  }

  return { items, separators };
}

/** Render the picker to stdout */
function render(state: {
  items: ModelItem[];
  separators: Set<number>;
  cursor: number;
  page: number;
  pageCount: number;
  current: string;
  search: string;
  searchMode: boolean;
}) {
  const { items, separators, cursor, page, pageCount, current, search, searchMode } = state;

  const lines: string[] = [];
  const W = Math.min(process.stdout.columns || 80, 100);
  const bar = chalk.gray('─'.repeat(W));

  lines.push('');
  lines.push(chalk.bold.white('  Select Model'));
  lines.push('');

  // Current model
  const curItem = items.find((m) => m.id === current);
  const curLabel = curItem ? `${chalk.cyan(curItem.provider + ' / ' + curItem.label)}` : chalk.cyan(current);
  lines.push(chalk.gray(`  current model: `) + curLabel + chalk.gray(` (${current})`));
  lines.push('');

  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, items.length);
  const pageItems = items.slice(start, end);

  let lastProvider = '';
  for (let i = 0; i < pageItems.length; i++) {
    const absIdx = start + i;
    const item = pageItems[i];
    const isCursor = absIdx === cursor;

    // Section header (provider group)
    const provLabel = item.provider === RECENT_KEY ? 'Recent' : item.provider;
    if (item.provider !== lastProvider) {
      if (lastProvider !== '' && separators.has(absIdx)) {
        lines.push(chalk.gray('  ' + '─'.repeat(40)));
      }
      lines.push('  ' + chalk.magenta('▸ ') + chalk.bold.magenta(provLabel));
      lastProvider = item.provider;
    }

    const arrow = chalk.gray(' → ');
    const detail = chalk.gray(`(${item.detail ?? item.id})`);
    const label = `${item.label}${arrow}${detail}`;

    if (isCursor) {
      lines.push(chalk.bgGray.white(`    ${label.padEnd(W - 6)}`));
    } else {
      lines.push(`    ${chalk.white(item.label)}${arrow}${detail}`);
    }
  }

  lines.push('');
  // Footer: page info
  lines.push(
    chalk.gray(`  Page ${page + 1} of ${pageCount}`) +
    ' '.repeat(Math.max(0, W - 30)) +
    chalk.gray(`Item ${cursor + 1} of ${items.length}`),
  );
  lines.push('');

  if (searchMode) {
    lines.push(chalk.gray(`  /`) + chalk.white(search) + chalk.bgWhite(' '));
  } else {
    lines.push(chalk.gray('  (/: search, ↑↓: navigate, ←→: page, Enter: select, ESC: cancel)'));
  }
  lines.push('');

  // Render: clear screen section and redraw
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor home
  process.stdout.write(lines.join('\n'));
}

/** Filter items by search query */
function filterItems(all: ModelItem[], query: string): ModelItem[] {
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter(
    (m) =>
      m.label.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q),
  );
}

/**
 * Show the interactive model picker.
 * Returns the selected model ID, or null if cancelled.
 */
export async function showModelPicker(
  available: ModelItem[],
  current: string,
  recentIds: string[] = [],
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    // Non-interactive: just return null
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let search = '';
    let searchMode = false;
    let allItems = available;

    const { items: baseItems, separators } = buildItems(allItems, current, recentIds);
    let filteredItems = baseItems;

    let cursor = Math.max(0, filteredItems.findIndex((m) => m.id === current));
    let page = Math.floor(cursor / PAGE_SIZE);

    const getPageCount = () => Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));

    const getState = () => ({
      items: filteredItems,
      separators,
      cursor,
      page,
      pageCount: getPageCount(),
      current,
      search,
      searchMode,
    });

    const rerender = () => render(getState());

    rerender();

    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    const cleanup = (result: string | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\x1b[2J\x1b[H'); // clear
      resolve(result);
    };

    const onData = (key: string) => {
      const ESC = '\x1b';
      const ENTER = '\r';
      const UP = '\x1b[A';
      const DOWN = '\x1b[B';
      const LEFT = '\x1b[D';
      const RIGHT = '\x1b[C';
      const BACKSPACE = '\x7f';
      const CTRL_C = '\x03';

      if (key === CTRL_C) {
        cleanup(null);
        process.exit(0);
      }

      if (searchMode) {
        if (key === ESC || (key === BACKSPACE && search.length === 0)) {
          searchMode = false;
          search = '';
          filteredItems = baseItems;
          cursor = 0;
          page = 0;
        } else if (key === BACKSPACE) {
          search = search.slice(0, -1);
          filteredItems = filterItems(baseItems, search);
          cursor = 0;
          page = 0;
        } else if (key === ENTER) {
          searchMode = false;
          if (filteredItems.length > 0) {
            cursor = 0;
            page = 0;
          }
        } else if (key.length === 1 && key >= ' ') {
          search += key;
          filteredItems = filterItems(baseItems, search);
          cursor = 0;
          page = 0;
        }
        rerender();
        return;
      }

      if (key === '/') {
        searchMode = true;
        search = '';
        rerender();
        return;
      }

      if (key === ESC) {
        cleanup(null);
        return;
      }

      if (key === ENTER) {
        const item = filteredItems[cursor];
        cleanup(item ? item.id : null);
        return;
      }

      if (key === UP) {
        if (cursor > 0) {
          cursor--;
          page = Math.floor(cursor / PAGE_SIZE);
        }
        rerender();
        return;
      }

      if (key === DOWN) {
        if (cursor < filteredItems.length - 1) {
          cursor++;
          page = Math.floor(cursor / PAGE_SIZE);
        }
        rerender();
        return;
      }

      if (key === LEFT) {
        if (page > 0) {
          page--;
          cursor = page * PAGE_SIZE;
        }
        rerender();
        return;
      }

      if (key === RIGHT) {
        if (page < getPageCount() - 1) {
          page++;
          cursor = page * PAGE_SIZE;
        }
        rerender();
        return;
      }
    };

    stdin.on('data', onData);
  });
}
