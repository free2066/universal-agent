/**
 * lsp-tool.ts — LSPTool: Language Server Protocol integration
 *
 * Mirrors claude-code's LSPTool.ts design.
 *
 * Provides code intelligence operations via LSP (Language Server Protocol):
 *   - goToDefinition    — find where a symbol is defined
 *   - findReferences    — find all usages of a symbol
 *   - hover             — get type/documentation for a symbol
 *   - documentSymbol    — list all symbols in a file
 *   - workspaceSymbol   — search symbols across the workspace
 *   - goToImplementation — find implementations of an interface/abstract method
 *   - prepareCallHierarchy — prepare call hierarchy for a function
 *   - incomingCalls     — find who calls a function
 *   - outgoingCalls     — find what a function calls
 *
 * Enabled only when ENABLE_LSP_TOOL=true environment variable is set.
 * Requires a compatible LSP server (e.g. typescript-language-server, pylsp).
 *
 * Round 6: claude-code LSPTool parity (skeleton)
 */

import { existsSync } from 'fs';
import { resolve, extname } from 'path';
import { spawn } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000; // 10 MB (matches claude-code)

/** Map of file extensions to LSP server commands */
const LSP_SERVERS: Record<string, { command: string; args: string[] }> = {
  '.ts':  { command: 'typescript-language-server', args: ['--stdio'] },
  '.tsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.js':  { command: 'typescript-language-server', args: ['--stdio'] },
  '.jsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.py':  { command: 'pylsp', args: [] },
  '.go':  { command: 'gopls', args: [] },
  '.rs':  { command: 'rust-analyzer', args: [] },
  '.java': { command: 'jdtls', args: [] },
};

// ── LSP Operation types ───────────────────────────────────────────────────────

type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';

// ── Simple LSP JSON-RPC client ────────────────────────────────────────────────

let _reqId = 1;

function makeRequest(method: string, params: unknown): string {
  const id = _reqId++;
  const request = { jsonrpc: '2.0', id, method, params };
  const body = JSON.stringify(request);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/**
 * Make a single LSP request via stdin/stdout of the LSP server process.
 * Spawns the server, sends initialize + the operation, reads result, kills server.
 *
 * This is intentionally a "fire once" client — not a persistent connection,
 * matching claude-code's lightweight approach for CLI usage.
 */
async function makeLspRequest(
  serverCmd: string,
  serverArgs: string[],
  rootPath: string,
  filePath: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(serverCmd, serverArgs, {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let buffer = '';
    let initDone = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse Content-Length framed responses
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;

        const header = buffer.slice(0, headerEnd);
        const clMatch = /Content-Length: (\d+)/i.exec(header);
        if (!clMatch) { buffer = buffer.slice(headerEnd + 4); break; }

        const contentLength = parseInt(clMatch[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) break;

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);

        let parsed: { id?: number; result?: unknown; error?: unknown };
        try { parsed = JSON.parse(body) as typeof parsed; } catch { continue; }

        if (!initDone && parsed.id === 1) {
          // Initialize response — send the actual request
          initDone = true;
          const initialized = makeRequest('initialized', {});
          const actualReq = makeRequest(method, params);
          proc.stdin.write(initialized);
          proc.stdin.write(actualReq);
        } else if (initDone && parsed.id === 2) {
          // Response to our actual request
          if (parsed.error) {
            reject(new Error(JSON.stringify(parsed.error)));
          } else {
            resolve(parsed.result);
          }
          proc.kill();
          return;
        }
      }
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`LSP server exited with code ${code}`));
      }
    });

    // Send initialize request
    const initRequest = makeRequest('initialize', {
      processId: process.pid,
      rootUri: `file://${rootPath}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: `file://${rootPath}`, name: 'workspace' }],
    });

    proc.stdin.write(initRequest);

    // Timeout after 10s
    setTimeout(() => {
      proc.kill();
      reject(new Error('LSP server timed out after 10s'));
    }, 10_000);
  });
}

// ── Format LSP results ────────────────────────────────────────────────────────

function formatLspResult(operation: LspOperation, result: unknown): string {
  if (!result) return `[LSP] No results for ${operation}.`;

  const cwd = process.cwd();

  if (operation === 'hover') {
    const hover = result as { contents?: { value?: string } | string };
    const content = typeof hover.contents === 'string'
      ? hover.contents
      : hover.contents?.value ?? '(no hover content)';
    return `Hover:\n${content}`;
  }

  if (operation === 'documentSymbol' || operation === 'workspaceSymbol') {
    const symbols = result as Array<{ name: string; kind: number; location?: { uri: string; range: { start: { line: number } } } }>;
    if (!Array.isArray(symbols) || symbols.length === 0) return '[LSP] No symbols found.';
    return symbols
      .slice(0, 50)
      .map((s) => {
        const uri = s.location?.uri?.replace(`file://${cwd}/`, '') ?? '';
        const line = (s.location?.range?.start?.line ?? 0) + 1;
        return `  ${s.name} (kind=${s.kind})${uri ? ` — ${uri}:${line}` : ''}`;
      })
      .join('\n');
  }

  // Location-based results (definition, references, implementation)
  const locations = Array.isArray(result) ? result : [result];
  if (locations.length === 0) return `[LSP] No results for ${operation}.`;

  return locations
    .slice(0, 20)
    .map((loc: { uri: string; range: { start: { line: number; character: number } } }) => {
      const filePath = loc.uri.replace(`file://${cwd}/`, '').replace(`file://`, '');
      const line = (loc.range?.start?.line ?? 0) + 1;
      const char = (loc.range?.start?.character ?? 0) + 1;
      return `  ${filePath}:${line}:${char}`;
    })
    .join('\n');
}

// ── Tool registration ─────────────────────────────────────────────────────────

export const lspTool: ToolRegistration = {
  searchHint: 'code intelligence diagnostics hover completions language server',
  definition: {
    name: 'LSP',
    description: [
      'Language Server Protocol (LSP) integration for code intelligence.',
      'Requires LSP server to be installed and ENABLE_LSP_TOOL=true.',
      '',
      'Operations:',
      '  goToDefinition      — Find where a symbol is defined',
      '  findReferences      — Find all usages of a symbol',
      '  hover               — Get type/documentation for a symbol',
      '  documentSymbol      — List all symbols in a file',
      '  workspaceSymbol     — Search symbols across the workspace',
      '  goToImplementation  — Find implementations of interface/abstract method',
      '  prepareCallHierarchy — Prepare call hierarchy for a function',
      '  incomingCalls       — Find what calls a function',
      '  outgoingCalls       — Find what a function calls',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          description: 'LSP operation to perform',
        },
        filePath: {
          type: 'string',
          description: 'Absolute or relative path to the file',
        },
        line: {
          type: 'number',
          description: '1-based line number',
        },
        character: {
          type: 'number',
          description: '1-based character offset',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name for workspaceSymbol queries',
        },
      },
      required: ['operation', 'filePath'],
    },
  },

  async handler(args: unknown): Promise<string> {
    // Check feature gate
    if (process.env.ENABLE_LSP_TOOL !== 'true') {
      return '[LSP] LSP tool is disabled. Set ENABLE_LSP_TOOL=true to enable.';
    }

    const input = args as {
      operation?: LspOperation;
      filePath?: string;
      line?: number;
      character?: number;
      symbol?: string;
    };

    const operation = input.operation;
    const filePathRaw = (input.filePath ?? '').trim();
    const line = (input.line ?? 1) - 1; // Convert to 0-based
    const character = (input.character ?? 1) - 1; // Convert to 0-based
    const symbol = input.symbol?.trim() ?? '';

    // Validate operation
    const validOps: LspOperation[] = [
      'goToDefinition', 'findReferences', 'hover', 'documentSymbol',
      'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy',
      'incomingCalls', 'outgoingCalls',
    ];
    if (!operation || !validOps.includes(operation)) {
      return `[LSP] Error: invalid operation "${operation}". Valid: ${validOps.join(', ')}`;
    }

    if (!filePathRaw) {
      return '[LSP] Error: filePath is required';
    }

    const cwd = process.cwd();
    const absFilePath = resolve(cwd, filePathRaw);

    // Validate file
    if (!existsSync(absFilePath)) {
      return `[LSP] Error: file not found: ${absFilePath}`;
    }

    const { statSync } = await import('fs');
    const st = statSync(absFilePath);
    if (st.size > MAX_LSP_FILE_SIZE_BYTES) {
      return `[LSP] Error: file too large (${st.size} bytes, max ${MAX_LSP_FILE_SIZE_BYTES})`;
    }

    // Find appropriate LSP server
    const ext = extname(absFilePath).toLowerCase();
    const serverConfig = LSP_SERVERS[ext];
    if (!serverConfig) {
      return `[LSP] No LSP server configured for "${ext}" files. Supported: ${Object.keys(LSP_SERVERS).join(', ')}`;
    }

    // Check if LSP server is available
    try {
      const { execSync } = await import('child_process');
      execSync(`which ${serverConfig.command} 2>/dev/null`, { timeout: 2000 });
    } catch {
      return `[LSP] LSP server not found: ${serverConfig.command}. Please install it first.`;
    }

    // Build LSP params
    const textDocumentUri = `file://${absFilePath}`;
    const position = { line, character };
    const textDocumentPosition = { textDocument: { uri: textDocumentUri }, position };

    let method: string;
    let params: unknown;

    switch (operation) {
      case 'goToDefinition':
        method = 'textDocument/definition';
        params = textDocumentPosition;
        break;
      case 'findReferences':
        method = 'textDocument/references';
        params = { ...textDocumentPosition, context: { includeDeclaration: true } };
        break;
      case 'hover':
        method = 'textDocument/hover';
        params = textDocumentPosition;
        break;
      case 'documentSymbol':
        method = 'textDocument/documentSymbol';
        params = { textDocument: { uri: textDocumentUri } };
        break;
      case 'workspaceSymbol':
        method = 'workspace/symbol';
        params = { query: symbol };
        break;
      case 'goToImplementation':
        method = 'textDocument/implementation';
        params = textDocumentPosition;
        break;
      case 'prepareCallHierarchy':
        method = 'textDocument/prepareCallHierarchy';
        params = textDocumentPosition;
        break;
      case 'incomingCalls':
        method = 'callHierarchy/incomingCalls';
        params = { item: { uri: textDocumentUri, range: { start: position, end: position } } };
        break;
      case 'outgoingCalls':
        method = 'callHierarchy/outgoingCalls';
        params = { item: { uri: textDocumentUri, range: { start: position, end: position } } };
        break;
      default:
        return `[LSP] Unsupported operation: ${operation}`;
    }

    try {
      const result = await makeLspRequest(
        serverConfig.command,
        serverConfig.args,
        cwd,
        absFilePath,
        method,
        params,
      );
      return formatLspResult(operation, result);
    } catch (e) {
      return `[LSP] Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
