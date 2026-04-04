/**
 * WebSocket MCP Server Tools
 *
 * Inspired by kstack #15370 "长链接 MCP":
 * The article describes a Mac MCP server that maintains persistent WebSocket connections
 * with iOS clients, enabling real-time event forwarding (live streaming signals, route control).
 *
 * For universal-agent, this means:
 *   1. Agent can START a WebSocket MCP server on a local port
 *   2. External clients (mobile apps, browsers, other processes) connect to it
 *   3. Agent can BROADCAST events to all connected clients in real time
 *   4. Agent can RECEIVE messages sent by clients (stored in an inbox)
 *   5. Agent can INJECT mock data/events to simulate external signals
 *
 * Use cases:
 *   - Mobile app → Agent: send debug signals, trigger agent actions
 *   - Agent → Mobile app: push results, notifications, state changes
 *   - Testing: simulate live events without real devices
 *   - Integration: bridge between Agent and any WebSocket-capable client
 *
 * Implementation uses Node.js net module (no external deps) with a simple
 * WebSocket handshake + framing protocol.
 *
 * Tools:
 *   WsServerStart   — Start the WebSocket MCP server on a given port
 *   WsServerStop    — Stop the server and disconnect all clients
 *   WsServerStatus  — Show connected clients and recent message stats
 *   WsBroadcast     — Send a message/event to all connected clients
 *   WsInbox         — Read messages received from clients
 *   WsMockInject    — Inject a mock event (as if a client sent it)
 */

import { createServer as createNetServer, type Server, type Socket } from 'net';
import { createHash } from 'crypto';
import type { ToolRegistration } from '../../../models/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WsClient {
  id: string;
  socket: Socket;
  ip: string;
  connectedAt: number;
  messagesSent: number;
  messagesReceived: number;
  label?: string;   // optional client-assigned label
}

interface WsMessage {
  from: string;     // client id or 'system'
  data: string;
  timestamp: number;
  type: 'text' | 'binary' | 'system';
}

// ── Singleton server state ─────────────────────────────────────────────────────

class WsMcpServer {
  private server: Server | null = null;
  private clients = new Map<string, WsClient>();
  private inbox: WsMessage[] = [];
  private port = 0;
  private startedAt = 0;
  private readonly MAX_INBOX = 200;

  isRunning(): boolean { return this.server !== null; }
  getPort(): number { return this.port; }
  getClientCount(): number { return this.clients.size; }

  // ── Start ────────────────────────────────────────────────────────────────────

  start(port: number): Promise<{ port: number; url: string }> {
    if (this.server) {
      return Promise.resolve({ port: this.port, url: `ws://localhost:${this.port}` });
    }

    return new Promise((resolve, reject) => {
      const server = createNetServer();

      server.on('connection', (socket: Socket) => {
        this.handleRawSocket(socket);
      });

      server.on('error', (err: Error) => {
        this.server = null;
        reject(err);
      });

      server.listen(port, '0.0.0.0', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        this.server = server;
        this.startedAt = Date.now();
        this.pushSystemMessage(`WebSocket MCP server started on port ${this.port}`);
        resolve({ port: this.port, url: `ws://localhost:${this.port}` });
      });
    });
  }

  // ── WebSocket HTTP Upgrade Handshake ──────────────────────────────────────────

  private handleRawSocket(socket: Socket) {
    let handshakeDone = false;
    let buffer = '';
    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    socket.setEncoding('utf-8');

    socket.on('data', (chunk: string) => {
      if (!handshakeDone) {
        buffer += chunk;
        if (buffer.includes('\r\n\r\n')) {
          // HTTP upgrade request received — perform WebSocket handshake
          const key = buffer.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
          if (!key) { socket.destroy(); return; }

          // SHA-1 is REQUIRED here by RFC 6455 §4.2.2 — the WebSocket handshake
          // algorithm is: SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"), base64.
          // This is NOT a cryptographic/security use — every browser and WS client
          // expects exactly this algorithm. Replacing with SHA-256 would break all
          // WebSocket clients. Static analysers that flag this are producing a false positive.
          const accept = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            '\r\n'
          );

          handshakeDone = true;
          buffer = '';

          const client: WsClient = {
            id: clientId,
            socket,
            ip: socket.remoteAddress ?? 'unknown',
            connectedAt: Date.now(),
            messagesSent: 0,
            messagesReceived: 0,
          };
          this.clients.set(clientId, client);
          this.pushSystemMessage(`Client connected: ${clientId} from ${client.ip}`);
        }
      } else {
        // Parse WebSocket frames (simplified: text frames only)
        this.parseWsFrames(chunk, clientId);
      }
    });

    socket.on('close', () => {
      if (this.clients.has(clientId)) {
        this.clients.delete(clientId);
        this.pushSystemMessage(`Client disconnected: ${clientId}`);
      }
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  // ── WebSocket Frame Parser (text frames) ────────────────────────────────────

  private parseWsFrames(raw: string, clientId: string) {
    // Convert string to Buffer for proper byte-level parsing
    const buf = Buffer.from(raw, 'binary');
    let offset = 0;

    while (offset + 2 <= buf.length) {
      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let payloadLen = b1 & 0x7f;

      offset += 2;

      if (payloadLen === 126) {
        if (offset + 2 > buf.length) break;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (offset + 8 > buf.length) break;
        payloadLen = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (offset + 4 > buf.length) break;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }

      if (offset + payloadLen > buf.length) break;
      const payload = buf.slice(offset, offset + payloadLen);
      offset += payloadLen;

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        // Close frame
        this.clients.get(clientId)?.socket.destroy();
        return;
      }

      if (opcode === 0x1) {
        // Text frame
        const text = payload.toString('utf-8');
        const client = this.clients.get(clientId);
        if (client) client.messagesReceived++;
        this.inbox.push({ from: clientId, data: text, timestamp: Date.now(), type: 'text' });
        if (this.inbox.length > this.MAX_INBOX) this.inbox.shift();
      }
    }
  }

  // ── Send to clients ──────────────────────────────────────────────────────────

  private encodeWsFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf-8');
    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
  }

  broadcast(message: string | object): { sent: number; failed: number } {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const frame = this.encodeWsFrame(text);
    let sent = 0; let failed = 0;

    for (const client of this.clients.values()) {
      try {
        client.socket.write(frame);
        client.messagesSent++;
        sent++;
      } catch {
        failed++;
        this.clients.delete(client.id);
      }
    }
    return { sent, failed };
  }

  sendTo(clientId: string, message: string | object): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const frame = this.encodeWsFrame(text);
    try {
      client.socket.write(frame);
      client.messagesSent++;
      return true;
    } catch {
      this.clients.delete(clientId);
      return false;
    }
  }

  // ── Stop ─────────────────────────────────────────────────────────────────────

  stop(): void {
    for (const client of this.clients.values()) {
      try { client.socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.port = 0;
  }

  // ── Inbox ────────────────────────────────────────────────────────────────────

  getInbox(last = 20): WsMessage[] {
    return this.inbox.slice(-last);
  }

  clearInbox(): void {
    this.inbox = [];
  }

  injectMockMessage(data: string, fromLabel = 'mock-client'): void {
    this.inbox.push({ from: fromLabel, data, timestamp: Date.now(), type: 'text' });
    if (this.inbox.length > this.MAX_INBOX) this.inbox.shift();
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  getStatus(): string {
    if (!this.server) return '🔴 WebSocket MCP Server: not running';

    const uptime = ((Date.now() - this.startedAt) / 1000 / 60).toFixed(1);
    const lines = [
      `🟢 WebSocket MCP Server — ws://localhost:${this.port}`,
      `   Uptime:   ${uptime} minutes`,
      `   Clients:  ${this.clients.size} connected`,
      `   Inbox:    ${this.inbox.length} message(s)`,
      '',
    ];

    if (this.clients.size > 0) {
      lines.push('   Connected clients:');
      for (const c of this.clients.values()) {
        const age = ((Date.now() - c.connectedAt) / 1000).toFixed(0);
        lines.push(`     ${c.id}  ip=${c.ip}  age=${age}s  sent=${c.messagesSent}  rcvd=${c.messagesReceived}${c.label ? `  [${c.label}]` : ''}`);
      }
    }

    return lines.join('\n');
  }

  private pushSystemMessage(msg: string) {
    this.inbox.push({ from: 'system', data: msg, timestamp: Date.now(), type: 'system' });
    if (this.inbox.length > this.MAX_INBOX) this.inbox.shift();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const wsMcpServer = new WsMcpServer();

// ── Tools ─────────────────────────────────────────────────────────────────────

export const wsServerStartTool: ToolRegistration = {
  definition: {
    name: 'WsServerStart',
    description: [
      'Start a WebSocket MCP server on a local port (inspired by kstack #15370 长链接 MCP).',
      'External clients (mobile apps, browsers, other processes) can connect to it via WebSocket.',
      'Use WsBroadcast to push events to all clients, WsInbox to read messages from clients.',
      'The server stays alive in the background until WsServerStop is called.',
      'Connection URL: ws://localhost:<port>',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'Port to listen on (default: 8765). Use 0 for auto-assign.',
        },
      },
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const port = Number(args.port ?? 8765);
    if (wsMcpServer.isRunning()) {
      return [
        `⚠️  WebSocket MCP server is already running.`,
        wsMcpServer.getStatus(),
      ].join('\n');
    }
    try {
      const { port: actualPort, url } = await wsMcpServer.start(port);
      return [
        `✅ WebSocket MCP Server started!`,
        `   URL:      ${url}`,
        `   Port:     ${actualPort}`,
        '',
        `Connect with any WebSocket client:`,
        `  Browser:  new WebSocket("${url}")`,
        `  CLI:      npx wscat -c ${url}`,
        `  Python:   import websocket; ws = websocket.WebSocket(); ws.connect("${url}")`,
        '',
        `Next steps:`,
        `  WsServerStatus  — check connections`,
        `  WsBroadcast     — send event to all clients`,
        `  WsInbox         — read messages from clients`,
        `  WsMockInject    — inject mock events for testing`,
      ].join('\n');
    } catch (err) {
      return `❌ Failed to start WebSocket server: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const wsServerStopTool: ToolRegistration = {
  definition: {
    name: 'WsServerStop',
    description: 'Stop the WebSocket MCP server and disconnect all clients.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    if (!wsMcpServer.isRunning()) return '⚠️  WebSocket MCP server is not running.';
    const clients = wsMcpServer.getClientCount();
    wsMcpServer.stop();
    return `✅ WebSocket MCP server stopped. Disconnected ${clients} client(s).`;
  },
};

export const wsServerStatusTool: ToolRegistration = {
  definition: {
    name: 'WsServerStatus',
    description: 'Show WebSocket MCP server status: port, connected clients, message stats, inbox size.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    return wsMcpServer.getStatus();
  },
};

export const wsBroadcastTool: ToolRegistration = {
  definition: {
    name: 'WsBroadcast',
    description: [
      'Broadcast a message or event to ALL connected WebSocket clients.',
      'Useful for pushing agent results, notifications, or state changes to external systems.',
      'Pass a JSON object for structured events, or a plain string for text messages.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message text to broadcast. For structured data, pass JSON as a string.',
        },
        event_type: {
          type: 'string',
          description: 'Optional event type label. If provided, wraps message in {type, data, timestamp} JSON.',
        },
      },
      required: ['message'],
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    if (!wsMcpServer.isRunning()) {
      return '❌ WebSocket MCP server is not running. Start it first with WsServerStart.';
    }
    const message = String(args.message ?? '');
    const eventType = args.event_type ? String(args.event_type) : null;
    const payload = eventType
      ? JSON.stringify({ type: eventType, data: message, timestamp: new Date().toISOString() })
      : message;

    const { sent, failed } = wsMcpServer.broadcast(payload);
    if (sent === 0 && failed === 0) {
      return '⚠️  No clients connected. Use WsServerStatus to check.';
    }
    return `✅ Broadcast sent to ${sent} client(s)${failed > 0 ? ` (${failed} failed)` : ''}.`;
  },
};

export const wsInboxTool: ToolRegistration = {
  definition: {
    name: 'WsInbox',
    description: [
      'Read messages received from WebSocket clients.',
      'Returns the most recent N messages (default: 20).',
      'Use this to see what external clients have sent to the agent.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        last: {
          type: 'number',
          description: 'Number of recent messages to show (default: 20, max: 200).',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the inbox after reading.',
        },
        filter_client: {
          type: 'string',
          description: 'Filter messages from a specific client ID.',
        },
      },
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const last = Math.min(Number(args.last ?? 20), 200);
    const clear = Boolean(args.clear ?? false);
    const filterClient = args.filter_client ? String(args.filter_client) : null;

    let messages = wsMcpServer.getInbox(last);
    if (filterClient) messages = messages.filter((m) => m.from === filterClient);

    if (messages.length === 0) {
      return '📭 Inbox is empty. No messages received yet.';
    }

    const lines = [`📬 WebSocket Inbox (${messages.length} message(s)):\n`];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const icon = msg.type === 'system' ? '🔧' : msg.from === 'mock-client' ? '🎭' : '💬';
      lines.push(`${icon} [${time}] from=${msg.from}`);
      lines.push(`   ${msg.data.slice(0, 300)}${msg.data.length > 300 ? '...' : ''}`);
    }

    if (clear) {
      wsMcpServer.clearInbox();
      lines.push('\n🗑️  Inbox cleared.');
    }

    return lines.join('\n');
  },
};

export const wsMockInjectTool: ToolRegistration = {
  definition: {
    name: 'WsMockInject',
    description: [
      'Inject a mock message into the inbox, as if a client sent it.',
      'Useful for testing agent logic without a real client.',
      'Inspired by kstack #15370: "支持信令调试、mock 注入".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'Message data to inject. Use JSON for structured events.',
        },
        from_label: {
          type: 'string',
          description: 'Label for the mock sender (default: "mock-client").',
        },
      },
      required: ['data'],
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const data = String(args.data ?? '');
    const label = args.from_label ? String(args.from_label) : 'mock-client';
    wsMcpServer.injectMockMessage(data, label);
    return [
      `🎭 Mock message injected into inbox.`,
      `   From:  ${label}`,
      `   Data:  ${data.slice(0, 200)}${data.length > 200 ? '...' : ''}`,
      '',
      `Read it with: WsInbox`,
    ].join('\n');
  },
};
