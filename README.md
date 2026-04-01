# 🤖 Universal Agent CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

A **universal multi-domain AI Agent CLI** — not just for programming, but for **data analysis**, **customer service**, **code review**, **self-healing**, and any domain you add as a plugin. Supports 20+ frontier models across OpenAI, Anthropic, Google, Mistral, Qwen, DeepSeek, Grok, and local Ollama.

```
╔═══════════════════════════════════════════╗
║   🤖  Universal Agent CLI  v0.1.0         ║
║   Multi-domain AI powered assistant       ║
╚═══════════════════════════════════════════╝
  Domains: data | dev | service | auto
```

## ✨ Features

| Domain | Capabilities |
|--------|-------------|
| 📊 **data** | CSV/JSON analysis, EDA reports, SQL generation/optimization, data quality checks |
| 💻 **dev** | Code review, bug detection, code execution, git summaries, refactoring |
| 🎧 **service** | Ticket classification, sentiment analysis, FAQ search, response generation |
| 🔄 **auto** | Automatically detects the best domain for your request |

### 🌟 Advanced Features

- **🔌 MCP Support** — Connect any Model Context Protocol server (filesystem, GitHub, databases, etc.)
- **👥 Subagent System** — Delegate tasks to specialized sub-agents via `@run-agent-<name>` mentions; supports **parallel fan-out** with `parallel_tasks[]` for concurrent execution
- **🧹 Zombie Agent Detection** — `/agents clean [days]` lists stale subagents that haven't been used in N days; usage stats tracked in `~/.uagent/agent-usage.json`
- **🗜️ Auto-Compact** — Automatically compresses conversation history when approaching context limits (75% threshold)
- **✂️ Context Editing** — Selectively clears old tool-result messages to free context before compaction kicks in
- **🔁 Tool Retry** — Automatic exponential-backoff retry on transient tool failures (configurable)
- **🛡️ Model Fallback** — Automatically fails over to backup models on LLM errors (`AGENT_FALLBACK_MODELS=model1,model2`)
- **🔭 Tool Selector** — Filters relevant tools per query when many are registered, preventing LLM confusion
- **🔓 Conditional Tool Loading** — Tools can be unlocked dynamically based on execution results (no scope creep)
- **⚠️ Harness Constraints** — Hard behavioral rules injected into every system prompt: CLI-first execution, no fallback scripting, schema adherence enforced
- **📐 Schema Validation** — Tool inputs validated against `ToolDefinition.parameters` before execution; violations surface as clear errors
- **🔍 Code Inspection** — Static analysis for bugs, security issues, and performance problems
- **🩺 Self-Healing** — Automatically detect and fix code issues, verify build, commit fixes
- **🌐 Web Tools** — `WebFetch` (fetch and extract any URL) + `WebSearch` (DuckDuckGo, no API key required), both with MMR re-ranking
- **📜 Session History** — Persists prompts to `~/.uagent/history.jsonl`, scoped per-project
- **📝 Project Context** — Reads `AGENTS.md` / `CLAUDE.md` for project-specific instructions
- **🌿 Git Status** — Injects current `git status` snapshot into system prompt at session start
- **💰 Cost Tracking** — Real-time token usage and API cost monitoring per model

## 🚀 Quick Start

### Install from source

```bash
git clone https://github.com/free2066/universal-agent.git
cd universal-agent
npm install
npm run build

# Configure API keys
npm run dev -- config

# Start interactive chat
npm run dev -- chat
```

### Install globally

```bash
npm install -g universal-agent
uagent config    # set API keys
uagent chat      # start chatting
```

## 📖 Usage

### Interactive Mode

```bash
uagent chat                            # auto-detect domain
uagent chat --domain data              # lock to data domain
uagent chat --domain dev               # lock to dev domain
uagent chat --model gpt-4.1            # use GPT-4.1
uagent chat --model claude-opus-4-5    # use Claude Opus 4.5
uagent chat --model ollama:llama3      # use local Ollama
uagent chat --safe                     # enable safe mode (blocks dangerous commands)
uagent chat --verbose                  # show tool call details
```

### Single Command Mode

```bash
uagent run "Analyze this CSV file" --file data.csv
uagent run "Optimize this SQL query: SELECT * FROM orders WHERE date > '2024-01-01'"
uagent run "Review this Python function for bugs" --domain dev
```

### CLI Subcommands

```bash
uagent inspect [path]           # Static code inspection
uagent purify [path]            # Auto-fix code issues (self-healing)
uagent init                     # Initialize AGENTS.md for this project
uagent config                   # Configure API keys and settings
uagent domains                  # List available domains
uagent agents                   # List available subagents
uagent models list              # List configured model profiles
uagent models set main gpt-4.1  # Set active model pointer
uagent models export            # Export model config as YAML
uagent mcp list                 # List MCP servers
uagent mcp init                 # Initialize .mcp.json
```

### In-session Commands

| Command | Description |
|---------|-------------|
| `/domain data` | Switch to data analysis mode |
| `/domain dev` | Switch to programming mode |
| `/domain service` | Switch to customer service mode |
| `/model [name]` | Switch or cycle active model |
| `/cost` | Show token usage and cost |
| `/history [n]` | Show last n prompts (default 10) |
| `/inspect [path]` | Static code inspection |
| `/purify [--dry-run] [--commit]` | Auto-fix code issues |
| `/agents` | List available subagents |
| `/agents clean [days]` | Show zombie/stale subagents (default: 30 days) |
| `/models` | List model profiles |
| `/clear` | Clear conversation history |
| `/help` | Show help |
| `/exit` | Exit |

## 💬 Example Prompts

### Data Domain
```
[data] ❯ Analyze the user retention in sales.csv
[data] ❯ Generate an EDA report for dataset.csv
[data] ❯ Optimize this SQL: SELECT * FROM orders JOIN customers ON...
[data] ❯ Check data quality issues in my CSV file
[data] ❯ Generate a MySQL query to find top 10 customers by revenue this month
```

### Dev Domain
```
[dev] ❯ Review this Python function for security issues
[dev] ❯ What's the git history of my project?
[dev] ❯ Run this Python snippet: print([x**2 for x in range(10)])
[dev] ❯ Write unit tests for my authentication module
[dev] ❯ Fetch and summarize https://example.com/api-docs
```

### Service Domain
```
[service] ❯ Classify this ticket: "I can't login and my payment was charged twice!"
[service] ❯ What's the sentiment: "This is the worst service I've ever experienced!!!"
[service] ❯ Search FAQ for: how to reset password
[service] ❯ Draft a response to an angry customer about a delayed order
```

### Subagent Delegation
```
# Single agent
[auto] ❯ @run-agent-reviewer please review src/api.ts

# Parallel fan-out (concurrent execution)
[auto] ❯ Review auth module for both code quality and security
  → Task({ parallel_tasks: [
      { subagent_type: "reviewer", task: "Review auth module" },
      { subagent_type: "security-auditor", task: "Audit auth module" }
    ]})

# Ask a specific model
[auto] ❯ @ask-claude-opus-4-5 what's the best approach for this architecture?
```

## ⚙️ Configuration

```bash
uagent config
```

Or create `~/.uagent/.env`:
```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
GEMINI_API_KEY=AIza...          # or GOOGLE_API_KEY
MISTRAL_API_KEY=...
DEEPSEEK_API_KEY=...
MOONSHOT_API_KEY=...
DASHSCOPE_API_KEY=...           # for Qwen
OPENAI_BASE_URL=https://api.openai.com/v1   # optional, for proxy
OLLAMA_BASE_URL=http://localhost:11434       # optional, for local models
```

You can also put a `.env` file in your current working directory.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_FALLBACK_MODELS` | Comma-separated fallback models, e.g. `gpt-4o-mini,claude-3-5-haiku` |
| `AGENT_SCHEMA_VALIDATE` | Set to `0` to disable tool input schema validation |
| `AGENT_TOOL_SELECT_THRESHOLD` | Tool count threshold before filtering (default: `12`) |
| `AGENT_TOOL_SELECT_MAX` | Max tools sent to LLM per call (default: `10`) |
| `AGENT_TOOL_SELECT_ALWAYS` | Comma-separated tools always included (default: `Bash,Write,Edit,Read,LS,Grep`) |
| `AGENT_TOOL_SELECTION_LLM` | Set to `1` to use LLM for tool selection (slower, more accurate) |
| `AGENT_LOG_LEVEL` | Log level: `trace/debug/info/warn/error` (default: `info`) |
| `AGENT_VERBOSE` | Set to `1` for debug output |
| `AGENT_SAFE_MODE` | Set to `1` to block dangerous shell commands |
| `AGENT_PROJECT_DOC_MAX_BYTES` | Max bytes for AGENTS.md context (default: 32768) |

## 🤖 Supported Models

### OpenAI
| Model | Description |
|-------|-------------|
| `gpt-4.1` | Latest GPT-4.1 (1M context) |
| `gpt-4.1-mini` | Fast & cost-effective GPT-4.1 |
| `gpt-4.1-nano` | Ultra-fast, minimal cost |
| `gpt-4o` | Multimodal flagship |
| `gpt-4o-mini` | Affordable multimodal |
| `o3` | Advanced reasoning |
| `o4-mini` | Efficient reasoning |

### Anthropic
| Model | Description |
|-------|-------------|
| `claude-opus-4-5` | Most capable Claude (2025) |
| `claude-sonnet-4-5` | Balanced performance (2025) |
| `claude-haiku-4-5` | Fast & affordable (2025) |
| `claude-3-5-sonnet-20241022` | Previous generation |

### Google
| Model | Description |
|-------|-------------|
| `gemini-2.5-pro` | Best Gemini reasoning (1M ctx) |
| `gemini-2.5-flash` | Fastest Gemini |
| `gemini-2.0-flash` | Efficient multimodal |

### Mistral
| Model | Description |
|-------|-------------|
| `mistral-large-2503` | Most capable Mistral |
| `mistral-small-2503` | Cost-effective |

### Qwen (Alibaba)
| Model | Description |
|-------|-------------|
| `qwen3-235b-a22b` | Qwen3 235B MoE (Apr 2025) |
| `qwen3-32b` | Qwen3 32B dense |
| `qwen-max-2025-01-21` | Qwen Max |

### DeepSeek
| Model | Description |
|-------|-------------|
| `deepseek-v3-0324` | DeepSeek V3 (Mar 2025) |
| `deepseek-r1` | Reasoning model |

### Grok (xAI)
| Model | Description |
|-------|-------------|
| `grok-3` | Latest Grok 3 |
| `grok-3-mini` | Efficient Grok |

### Local
| Model | Description |
|-------|-------------|
| Any Ollama model | `--model ollama:llama3` |

## 🔌 MCP (Model Context Protocol)

Connect external tools and data sources via MCP servers.

Initialize with:
```bash
uagent mcp init
```

Edit `.mcp.json`:
```json
{
  "servers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "enabled": true
    },
    {
      "name": "github",
      "type": "sse",
      "url": "https://your-mcp-server/sse",
      "enabled": true
    }
  ]
}
```

## 🔍 Code Inspection & Self-Healing

```bash
# Static inspection
uagent inspect ./src --severity warning
uagent inspect ./src --category security --json   # JSON output

# Auto-fix issues
uagent purify ./src --dry-run         # preview only
uagent purify ./src --commit          # fix and commit
uagent purify ./src --severity error  # only critical fixes
```

Or in REPL:
```
[dev] ❯ /inspect src/api.ts
[dev] ❯ /purify --dry-run
[dev] ❯ /purify --commit
```

Inspection rules cover:
- **Security**: hardcoded secrets, SQL injection risks
- **Bugs**: unhandled promises, empty catch blocks, non-null assertions
- **Performance**: sync I/O in async context, array push in loops
- **Style**: `any` types, TODO/FIXME comments, magic numbers, long functions

## 🌐 Web Tools

Both tools are available in all domains without any configuration:

```
[auto] ❯ Search for the latest Node.js release notes
[auto] ❯ Fetch and summarize https://docs.example.com/api
[auto] ❯ What are the top results for "TypeScript 5.5 features"?
```

- **WebSearch** uses DuckDuckGo — no API key required, results MMR re-ranked
- **WebFetch** strips HTML, returns clean readable text; supports `text | links | both` extraction modes

## 📝 Project Context (AGENTS.md)

Create an `AGENTS.md` (or `CLAUDE.md`) at your project root to give the agent project-specific context:

```bash
uagent init   # creates AGENTS.md template
```

The agent automatically loads context from `AGENTS.md` at every session start. The file is truncated to 32KB by default (configurable via `AGENT_PROJECT_DOC_MAX_BYTES`).

## 🔄 Auto-Compact & Context Editing

Two layers of context management prevent hitting token limits:

1. **Context Editing** (lightweight, first): Selectively replaces old tool-result messages with `[cleared]` placeholders when history exceeds 80k tokens. Preserves the 3 most recent tool results intact.

2. **Auto-Compact** (heavy, second): When history exceeds 75% of the model's context window, summarizes older turns using a fast/cheap model and replaces them with a dense summary message.

Together they allow arbitrarily long sessions without hitting context limits.

## 👥 Subagent System

Built-in subagents available out of the box:

| Agent | Description |
|-------|-------------|
| `reviewer` | Code review specialist |
| `architect` | System design and architecture advisor |
| `test-writer` | Unit and integration test writer |
| `data-analyst` | Data analysis and visualization expert |
| `security-auditor` | Security vulnerability analysis |
| `doc-writer` | Documentation and README writer |

**Add custom agents** by creating `~/.uagent/agents/<name>.md` or `./.uagent/agents/<name>.md` with frontmatter:

```markdown
---
name: my-agent
description: What this agent specializes in
model: gpt-4o-mini
---
You are an expert in ...
```

**Parallel fan-out** runs multiple agents concurrently:
```
Task({
  parallel_tasks: [
    { subagent_type: "reviewer", task: "Review auth module" },
    { subagent_type: "security-auditor", task: "Audit auth module" }
  ]
})
```

**Zombie detection** finds unused agents:
```
[auto] ❯ /agents clean 30    # list agents unused for 30+ days
```

## 🔌 Adding Custom Domains

Create a new domain plugin in `src/domains/`:

```typescript
// src/domains/finance/index.ts
import type { DomainPlugin } from '../../models/types.js';

export const financeDomain: DomainPlugin = {
  name: 'finance',
  description: 'Financial analysis, budgeting, investment calculations',
  keywords: ['stock', 'portfolio', 'budget', 'revenue', 'profit'],
  systemPrompt: 'You are an expert financial analyst...',
  tools: [/* your tool registrations */],
};
```

Then register it in `src/core/domain-router.ts`.

## 📁 Project Structure

```
universal-agent/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry + REPL (slash commands)
│   │   ├── ui.ts                 # Banner and help UI
│   │   └── configure.ts          # API key configuration wizard
│   ├── core/
│   │   ├── agent.ts              # Core agent loop (tool calls + streaming)
│   │   ├── context-compressor.ts # Auto-compact long conversations
│   │   ├── context-editor.ts     # Selective tool-result clearing
│   │   ├── context-loader.ts     # AGENTS.md + Harness constraints injection
│   │   ├── domain-router.ts      # Domain detection and routing
│   │   ├── hooks.ts              # Internal event hooks (tool timing, logging)
│   │   ├── logger.ts             # Structured per-subsystem logger
│   │   ├── mcp-manager.ts        # MCP server connections
│   │   ├── mmr.ts                # MMR re-ranking for search deduplication
│   │   ├── model-fallback.ts     # Automatic model fallback chain
│   │   ├── session-history.ts    # Prompt persistence (~/.uagent/history.jsonl)
│   │   ├── subagent-system.ts    # Subagent delegation + parallel fan-out
│   │   ├── tool-registry.ts      # Tool registration, schema validation, conditional loading
│   │   ├── tool-retry.ts         # Exponential-backoff retry for tool calls
│   │   ├── tool-selector.ts      # Query-relevant tool filtering
│   │   └── tools/
│   │       ├── fs-tools.ts       # File system tools (Read/Write/Edit/Bash/LS/Grep)
│   │       ├── web-tools.ts      # WebFetch and WebSearch (DuckDuckGo)
│   │       ├── code-inspector.ts # Static code analysis (bugs/security/perf/style)
│   │       └── self-heal.ts      # Auto code-fix and build verification
│   ├── models/
│   │   ├── types.ts              # Shared TypeScript interfaces
│   │   ├── model-manager.ts      # Multi-provider model management + cost tracking
│   │   └── llm-client.ts         # OpenAI/Anthropic/Gemini/Mistral/Qwen/DeepSeek/Ollama clients
│   └── domains/
│       ├── data/                 # Data analysis domain
│       │   └── tools/            # CSV, SQL, EDA, cleaning tools
│       ├── dev/                  # Programming domain
│       │   └── tools/            # Code review, execution, git tools
│       └── service/              # Customer service domain
│           └── tools/            # Ticket, FAQ, sentiment tools
├── package.json
└── tsconfig.json
```

## 🛠️ Development

```bash
npm install          # Install dependencies
npm run dev          # Run in development mode (tsx)
npm run build        # Build TypeScript
npm test             # Run tests
npm run lint         # Lint source
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-domain`
3. Add your domain plugin in `src/domains/`
4. Update `src/core/domain-router.ts` to register it
5. Add tests in `tests/`
6. Submit a Pull Request

## 📄 License

MIT
