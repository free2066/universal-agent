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
- **👥 Subagent System** — Delegate tasks to specialized sub-agents via `@run-agent-<name>` mentions
- **🗜️ Auto-Compact** — Automatically compresses conversation history when approaching context limits (75% threshold)
- **📜 Session History** — Persists prompts to `~/.uagent/history.jsonl`, scoped per-project
- **🔍 Code Inspection** — Static analysis for bugs, security issues, and performance problems
- **🩺 Self-Healing** — Automatically detect and fix code issues, verify build, commit fixes
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
uagent inspect [path]    # Static code inspection
uagent purify [path]     # Auto-fix code issues (self-healing)
uagent init              # Initialize AGENTS.md for this project
uagent config            # Configure API keys and settings
uagent domains           # List available domains
uagent agents            # List available subagents
uagent models list       # List configured model profiles
uagent models set main gpt-4.1   # Set active model pointer
uagent mcp list          # List MCP servers
uagent mcp init          # Initialize .mcp.json
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
[auto] ❯ @run-agent-code-reviewer please review src/api.ts
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
MISTRAL_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1   # optional, for proxy
OLLAMA_BASE_URL=http://localhost:11434       # optional, for local models
```

You can also put a `.env` file in your current working directory.

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

# Auto-fix issues
uagent purify ./src --dry-run         # preview only
uagent purify ./src --commit          # fix and commit
uagent purify ./src --severity error  # only critical fixes
```

Or in REPL:
```
[dev] ❯ /inspect src/api.ts
[dev] ❯ /purify --dry-run
```

## 📝 Project Context (AGENTS.md)

Create an `AGENTS.md` (or `CLAUDE.md`) at your project root to give the agent project-specific context:

```bash
uagent init   # creates AGENTS.md template
```

The agent automatically loads context from `AGENTS.md` at every session start.

## 🔄 Auto-Compact

When conversation history exceeds 75% of the model's context window, the agent automatically:
1. Takes the oldest turns
2. Summarizes them using a fast/cheap model
3. Replaces them with a dense summary message

This allows long-running sessions without hitting context limits.

## 📜 Session History

All prompts are persisted to `~/.uagent/history.jsonl` (per-project, deduped).

```
[auto] ❯ /history 20     # show last 20 prompts
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
│   │   ├── agent.ts              # Core agent loop (tool calls + LLM)
│   │   ├── context-compressor.ts # Auto-compact long conversations
│   │   ├── context-loader.ts     # AGENTS.md + git status injection
│   │   ├── domain-router.ts      # Domain detection and routing
│   │   ├── mcp-manager.ts        # MCP server connections
│   │   ├── session-history.ts    # Prompt persistence (~/.uagent/history.jsonl)
│   │   ├── subagent-system.ts    # Subagent delegation system
│   │   └── tool-registry.ts      # Tool registration and execution
│   │   └── tools/
│   │       ├── fs-tools.ts       # File system tools (read/write/edit/bash/grep)
│   │       ├── web-tools.ts      # Web fetch and search
│   │       ├── code-inspector.ts # Static code analysis
│   │       └── self-heal.ts      # Auto code-fix and build verification
│   ├── models/
│   │   ├── types.ts              # Shared TypeScript interfaces
│   │   ├── model-manager.ts      # Multi-provider model management + cost tracking
│   │   └── llm-client.ts         # OpenAI / Anthropic / Google / Mistral / Ollama clients
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
