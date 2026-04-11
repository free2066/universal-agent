/**
 * Hash-Anchored Edit MCP Server
 *
 * Exposes two tools to LLM agents:
 *   1. hashline_read  — reads a file and returns LINE#ID-prefixed content
 *   2. hashline_edit  — applies LINE#ID-anchored edits to a file
 *
 * LINE#ID format: "lineNumber#XX" e.g. "11#XJ"
 * Edits are validated against the current file hash before application.
 * On mismatch, the error message includes the correct LINE#IDs.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { formatHashLine } from './hashline/hash-computation.js'
import { normalizeHashlineEdits } from './hashline/normalize-edits.js'
import { applyHashlineEditsWithReport } from './hashline/edit-operations.js'
import type { RawHashlineEdit } from './hashline/types.js'

// --------------- Tool definitions ---------------

const HASHLINE_READ_TOOL = {
  name: 'hashline_read',
  description: `Read a file and return its content with LINE#ID anchors prepended to each line.

Each line is formatted as: "lineNumber#XX|content"
Example output:
  1#ZM|import { foo } from './foo'
  2#PK|
  3#VR|export function main() {

LINE#IDs are used as anchors for hashline_edit. They encode both the line number
and a hash of the line content, so edits will fail with a helpful error if the
file has changed since you read it.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
    },
    required: ['filePath'],
  },
}

const HASHLINE_EDIT_TOOL = {
  name: 'hashline_edit',
  description: `Apply LINE#ID-anchored edits to a file.

IMPORTANT: You must call hashline_read FIRST to get current LINE#IDs.
LINE#IDs encode line content — if the file has changed, the edit will fail
with an error showing the correct current LINE#IDs.

Operations:
- replace: Replace line(s) at pos (optionally through end) with new lines
  { op: "replace", pos: "11#XJ", lines: ["new content"] }
  { op: "replace", pos: "5#AB", end: "8#CD", lines: ["merged content"] }
  { op: "replace", pos: "3#ZM", lines: null }  // Delete line

- append: Insert lines AFTER pos (or end-of-file if pos omitted)
  { op: "append", pos: "11#XJ", lines: ["", "// new function", "function foo() {}"] }
  { op: "append", lines: ["// EOF comment"] }

- prepend: Insert lines BEFORE pos (or beginning-of-file if pos omitted)
  { op: "prepend", pos: "1#ZM", lines: ["// Header comment"] }

RULES:
1. All LINE#IDs in edits are validated against current file state BEFORE any edit is applied
2. Multiple edits in one call are applied bottom-to-top automatically (no line shift issues)
3. lines: null deletes the targeted line(s)
4. Overlapping replace ranges are rejected`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace', 'append', 'prepend'],
              description: 'Operation type',
            },
            pos: {
              type: 'string',
              description: 'LINE#ID anchor (e.g. "11#XJ")',
            },
            end: {
              type: 'string',
              description: 'LINE#ID end of range for replace (optional)',
            },
            lines: {
              description: 'New line content(s). String, array of strings, or null to delete',
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
            },
          },
          required: ['op'],
        },
      },
    },
    required: ['filePath', 'edits'],
  },
}

// --------------- Path validation ---------------

// Only allow access to files under cwd (passed via env var) or process.cwd().
// This prevents LLM prompt injection attacks from reading arbitrary files.
// P1: resolve WORKSPACE_ROOT to prevent relative/symlink bypass
const WORKSPACE_ROOT = resolve(process.env.UA_WORKSPACE_ROOT || process.cwd())

function validateFilePath(filePath: string): void {
  const resolved = resolve(filePath)
  const rel = relative(WORKSPACE_ROOT, resolved)
  // rel starts with '..' means it escaped the workspace root;
  // path.isAbsolute(rel) catches Windows cross-drive paths (e.g. D:\secret)
  if (rel.startsWith('..') || rel.startsWith('/') || isAbsolute(rel)) {
    throw new Error(
      `Access denied: "${filePath}" is outside the allowed workspace (${WORKSPACE_ROOT}). ` +
      `Only files under the workspace root are accessible via hashline tools.`,
    )
  }
}

// --------------- Handlers ---------------

async function handleHashlineRead(filePath: string): Promise<string> {
  validateFilePath(filePath)
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read file "${filePath}": ${(err as Error).message}`)
  }

  const lines = content.split('\n')
  // Strip trailing empty element produced by a trailing newline,
  // so the line count matches what applyHashlineEditsWithReport sees.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const result = lines
    .map((line, i) => formatHashLine(i + 1, line))
    .join('\n')

  return result
}

async function handleHashlineEdit(
  filePath: string,
  rawEdits: RawHashlineEdit[],
): Promise<string> {
  validateFilePath(filePath)
  // Read current file content
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read file "${filePath}": ${(err as Error).message}`)
  }

  // Normalize and validate edits
  const edits = normalizeHashlineEdits(rawEdits)

  // Apply edits (throws HashlineMismatchError with correction hints on hash failure)
  const { content: newContent, noopEdits, deduplicatedEdits } = applyHashlineEditsWithReport(
    content,
    edits,
  )

  // Check if anything actually changed
  if (newContent === content) {
    const noopMsg =
      noopEdits.length > 0
        ? ` (${noopEdits.length} edit(s) were no-ops — content already matched)`
        : ''
    return `No changes made to "${filePath}"${noopMsg}`
  }

  // Write updated content
  try {
    await writeFile(filePath, newContent, 'utf8')
  } catch (err) {
    throw new Error(`Cannot write file "${filePath}": ${(err as Error).message}`)
  }

  const lines = content.split('\n').length
  const newLines = newContent.split('\n').length
  const delta = newLines - lines
  const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`
  const dedupeMsg =
    deduplicatedEdits.length > 0
      ? ` (${deduplicatedEdits.length} duplicate edit(s) removed)`
      : ''

  return [
    `Successfully edited "${filePath}"`,
    `Applied ${edits.length - deduplicatedEdits.length} edit(s)${dedupeMsg}`,
    `Lines: ${lines} → ${newLines} (${deltaStr})`,
  ].join('\n')
}

// --------------- Server setup ---------------

const server = new Server(
  {
    name: 'hashline',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [HASHLINE_READ_TOOL, HASHLINE_EDIT_TOOL],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'hashline_read') {
      const filePath = args?.filePath as string
      if (!filePath) throw new Error('filePath is required')
      const result = await handleHashlineRead(filePath)
      return {
        content: [{ type: 'text' as const, text: result }],
      }
    }

    if (name === 'hashline_edit') {
      const filePath = args?.filePath as string
      const rawEdits = args?.edits as RawHashlineEdit[]
      if (!filePath) throw new Error('filePath is required')
      if (!rawEdits || !Array.isArray(rawEdits)) throw new Error('edits must be an array')
      const result = await handleHashlineEdit(filePath, rawEdits)
      return {
        content: [{ type: 'text' as const, text: result }],
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// --------------- Start ---------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Server is now listening on stdin/stdout
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
