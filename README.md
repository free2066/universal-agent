# universal-agent

> 🤖 A Claude Code fork with multi-LLM support — runs the full CC engine on OpenAI, Gemini, Ollama, or Kuaishou Wanqing models.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/version-1.2.32-orange)](package.json)

---

## What is this?

`universal-agent` is a fork of [Claude Code](https://github.com/anthropics/anthropic-sdk-typescript) (Anthropic's official CLI) that replaces the hard-wired Anthropic API with a multi-provider adapter. The full CC engine — agentic loop, multi-level compression, memory system, MCP, skills, tools — runs unchanged on top of any OpenAI-compatible endpoint.

**Supported backends**

| Provider | Model IDs | Notes |
|----------|-----------|-------|
| Anthropic (native) | `claude-*` | Full feature set incl. Prompt Cache |
| Kuaishou Wanqing | `ep-*` / `wanqing/<id>` | Internal enterprise endpoint |
| OpenAI | `gpt-4o`, `o3`, … | Standard OpenAI API |
| Gemini | `gemini-*` | via OpenAI-compat layer |
| Ollama | `ollama/<name>` | Local inference |
| Any OpenAI-compat | custom `ep-*` | Set `OPENAI_BASE_URL` |

---

## Features (CC core, fully inherited)

### Agentic Loop
- **Three-layer execution engine** — `QueryEngine` (session) → `submitMessage` (turn) → `queryLoop` (iteration)
- **ReAct pattern** — Reason → Act → Observe, loops until task complete
- **8 continue / 7 return paths** with per-path infinite-loop guards
- **Withheld error recovery** — 413 / max_output_tokens errors intercepted, recovered silently
- **Streaming tool execution** — tools start running while model is still generating
- **Stop Hooks** — user-configured shell scripts triggered after each model response

### Multi-level Context Compression
| Level | Strategy | Trigger |
|-------|----------|---------|
| L1① | Large result offload to disk (2 KB preview) | result > 50 K chars |
| L1② | Microcompact — clear old tool results | >60 min idle |
| L2 | Autocompact — LLM-generated 9-section summary | near context limit |
| L3 | History snip — drop old segments (feature-flagged) | manual / model-triggered |

### Memory System
- **CLAUDE.md** — layered instruction files: managed → user → project → local (4 scopes)
- **Auto memory** — forked agent extracts and persists per-turn learnings to `~/.claude/projects/*/memory/`
- **Relevant memory prefetch** — async semantic search, injected as attachments during iteration
- **Session memory** — rolling structured notes for fast compact (zero extra API call)
- **/remember command** — manually persist notes across sessions (personal / project / global)

### MCP (Model Context Protocol)
- **stdio / SSE / HTTP / WebSocket** server types
- **Full CRUD CLI** — `claude mcp list | add | remove | enable | disable | get | test`
- **/mcp** REPL command — live server status + tool inventory
- **Per-request tool refresh** — MCP tools hot-reload between iterations
- **Skill discovery** — async prefetch of relevant skills, injected as system-reminder

### Skills System
- **Inline mode** (default) — SKILL.md injected as invisible user message, model follows instructions
- **Fork mode** (`context: fork`) — isolated sub-agent, result returned as tool output
- **allowedTools** — auto-approve list per skill (no popup for listed tools)
- **`/skillname` slash commands** — skills invocable as slash commands

### Tool Suite (built-in)
File ops · Bash · Grep · Glob · WebSearch · WebFetch · Read · Write · Edit · MultiEdit · Notebook · TodoWrite/Read · Agent · Task scheduling · SnipTool

---

## Quick Start

### Prerequisites

- Node.js ≥ 18 or Bun ≥ 1.0
- API key for at least one backend

### Installation

```bash
git clone https://github.com/free2066/universal-agent.git
cd universal-agent
npm install
npm run build
npm link          # makes `claude` available globally
```

### Configuration

**Kuaishou Wanqing (internal)**

```bash
# ~/.uagent/.env
WQ_API_KEY=your-wanqing-api-key
OPENAI_BASE_URL=http://wanqing.internal/api/gateway/v1/endpoints
```

Then in `~/.claude/settings.json`:
```json
{
  "model": "ep-your-endpoint-id"
}
```

**Anthropic**

```bash
# ~/.uagent/.env
ANTHROPIC_API_KEY=sk-ant-...
```

**OpenAI / compatible**

```bash
# ~/.uagent/.env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # or any compatible endpoint
```

### First run

```bash
claude                          # interactive REPL
claude "explain this project"   # start with a prompt
claude -p "fix the lint errors" # non-interactive (print mode)
```

---

## Model Management

Models are stored in `~/.uagent/models.json`. The `pointers` map assigns roles:

```json
{
  "profiles": [
    {
      "name": "my-model",
      "provider": "openai",
      "modelName": "ep-xxxxxxxx",
      "apiKey": "...",
      "baseURL": "http://...",
      "displayName": "My Model"
    }
  ],
  "pointers": {
    "main":    "my-model",
    "task":    "my-model",
    "compact": "my-model",
    "quick":   "my-model"
  }
}
```

| Role | Used for |
|------|----------|
| `main` | Primary conversation model |
| `task` | Sub-agent / tool-heavy tasks |
| `compact` | Autocompact summary generation |
| `quick` | Fast one-shot operations (Haiku equivalent) |

**Fallback chain** — set `UA_FALLBACK_CHAIN=model-a,model-b,model-c` to auto-switch on API failure.

---

## MCP Configuration

Add servers globally in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "remote-server": {
      "url": "http://127.0.0.1:29170/index-mcp/streamable-http"
    }
  }
}
```

Or project-scoped in `.claude/settings.json` / `.mcp.json`.

**Via CLI:**
```bash
claude mcp add my-server -- npx -y @modelcontextprotocol/server-filesystem /path
claude mcp list
```

---

## /remember Command

Persist notes that survive context resets:

```
/remember This project uses GLM-5 via Wanqing endpoint
```

Storage targets:

| Flag | File | Scope |
|------|------|-------|
| (default) | `CLAUDE.local.md` in cwd | project, not committed |
| `--project` | `CLAUDE.md` in cwd | project, committed |
| `--global` | `~/.claude/CLAUDE.md` | all projects |

---

## Architecture

```
src/
├── services/
│   ├── api/
│   │   ├── claude.ts               # CC agentic loop (queryLoop, submitMessage, QueryEngine)
│   │   ├── multiModelAdapter.ts    # Anthropic → OpenAI/Wanqing protocol bridge
│   │   └── client.ts               # Provider routing (native Anthropic vs adapter)
│   └── compact/                    # L1/L2/L3 compression strategies
│
├── models/
│   ├── model-manager.ts            # Profile registry, pointer resolution
│   ├── llm/
│   │   ├── anthropic.ts            # Anthropic native client (Prompt Cache, betas)
│   │   ├── openai.ts               # OpenAI / Wanqing client
│   │   └── factory.ts              # createLLMClient() — wanqing/* / ep-* routing
│
├── commands/
│   ├── mcp/                        # MCP CRUD commands
│   ├── remember/                   # /remember slash command
│   └── ...
│
├── memdir/                         # Auto memory system (extract, find, MEMORY.md)
├── utils/                          # Prompt caching, token budget, system prompt builders
└── ...
```

**Provider routing decision:**

```
model ID
  ├─ starts with "claude-"   → AnthropicClient (full CC feature set)
  ├─ starts with "wanqing/"  → OpenAIClient(WQ_API_KEY, OPENAI_BASE_URL)
  ├─ starts with "ep-"       → OpenAIClient(WQ_API_KEY, OPENAI_BASE_URL)
  ├─ starts with "ollama/"   → OllamaClient
  └─ others                  → OpenAIClient(OPENAI_API_KEY, OPENAI_BASE_URL)
```

---

## Key Differences from Upstream CC

| Area | Upstream CC | universal-agent |
|------|-------------|-----------------|
| Backend | Anthropic only | Multi-provider via `multiModelAdapter` |
| Prompt Cache | Full (system + messages + tools) | Anthropic path only; stripped for non-Anthropic |
| Context Editing (L1③) | `firstParty` only | Same — requires Anthropic backend |
| Model config | `~/.claude/settings.json` model field | `~/.uagent/models.json` profile system |
| Fallback chain | `models.json` cascade | `UA_FALLBACK_CHAIN` env var |
| `/remember` | Not in upstream | Added in v1.2.32 |
| Session logging | Basic transcript | Enhanced HTML logs + context events |

---

## Changelog

### v1.2.32
- `/remember` command — persist notes to CLAUDE.md (personal / project / global)

### v1.2.21
- Bootstrap logging — version, node, bun, model profile, .env load status
- Error logging in `multiModelAdapter` with stack trace on API failures
- Model switch event logging in session logger

### v1.2.4
- Fixed: bootstrap not loading `~/.uagent/.env`, requests going to wrong endpoint
- Fixed: system prompt duplicated in messages array for non-Anthropic models
- Connect timeout support (`UAGENT_CONNECT_TIMEOUT_MS`, default 30s)

### v1.0.0
- Initial fork of Claude Code
- `multiModelAdapter` — Anthropic → OpenAI protocol bridge
- Wanqing (`ep-*` / `wanqing/*`) endpoint support
- `~/.uagent/models.json` profile system with role pointers
- `UA_FALLBACK_CHAIN` env var for model fallback

---

## Development

```bash
npm run dev          # TypeScript watch mode
npm run build        # production build → dist/
npx tsc --noEmit     # type check only
```

Logs at startup (set `DEBUG=1` or check `~/.uagent/logs/`).

---

## License

MIT — see [LICENSE](LICENSE) for details.
