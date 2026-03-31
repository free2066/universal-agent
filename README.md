# 🤖 Universal Agent CLI

[![npm version](https://img.shields.io/npm/v/universal-agent-cli.svg)](https://www.npmjs.com/package/universal-agent-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

A **universal multi-domain AI Agent CLI** — not just for programming, but for **data analysis**, **customer service**, **code review**, and any domain you add as a plugin.

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

## 🚀 Quick Start

### Install from npm (after publishing)

```bash
npm install -g universal-agent-cli
```

### Run from source

```bash
git clone https://github.com/YOUR_USERNAME/universal-agent.git
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
uagent chat                        # auto-detect domain
uagent chat --domain data          # lock to data domain
uagent chat --domain dev           # lock to dev domain
uagent chat --model claude-3-5-sonnet  # use Claude
uagent chat --model ollama:llama3  # use local Ollama
```

### Single Command Mode

```bash
uagent run "Analyze this CSV file" --file data.csv
uagent run "Optimize this SQL query: SELECT * FROM orders WHERE date > '2024-01-01'"
uagent run "Review this Python function for bugs" --domain dev
```

### In-session Commands

| Command | Description |
|---------|-------------|
| `/domain data` | Switch to data analysis mode |
| `/domain dev` | Switch to programming mode |
| `/domain service` | Switch to customer service mode |
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

## ⚙️ Configuration

```bash
uagent config
```

Or create `~/.uagent/.env`:
```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_BASE_URL=https://api.openai.com/v1   # optional, for proxy
OLLAMA_BASE_URL=http://localhost:11434       # optional, for local models
```

You can also put a `.env` file in your current working directory.

## 🤖 Supported Models

| Model | Provider | Flag |
|-------|----------|------|
| `gpt-4o` (default) | OpenAI | `--model gpt-4o` |
| `gpt-4o-mini` | OpenAI | `--model gpt-4o-mini` |
| `claude-3-5-sonnet-20241022` | Anthropic | `--model claude-3-5-sonnet-20241022` |
| `claude-3-haiku-20240307` | Anthropic | `--model claude-3-haiku-20240307` |
| Any Ollama model | Local | `--model ollama:llama3` |

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
│   │   ├── index.ts        # CLI entry point (commander + REPL)
│   │   ├── ui.ts           # Banner and help UI
│   │   └── configure.ts    # API key configuration
│   ├── core/
│   │   ├── agent.ts        # Core agent loop (tool calls + LLM)
│   │   ├── domain-router.ts # Domain detection and routing
│   │   └── tool-registry.ts # Tool registration and execution
│   ├── models/
│   │   ├── types.ts        # Shared TypeScript interfaces
│   │   └── llm-client.ts   # OpenAI / Anthropic / Ollama clients
│   └── domains/
│       ├── data/           # Data analysis domain
│       │   └── tools/      # CSV, SQL, EDA, cleaning tools
│       ├── dev/            # Programming domain
│       │   └── tools/      # Code review, execution, git tools
│       └── service/        # Customer service domain
│           └── tools/      # Ticket, FAQ, sentiment tools
├── skills/                 # Skill prompt files (YAML)
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

## 📦 Publishing to npm

```bash
npm login
npm publish --access public
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-domain`
3. Add your domain plugin in `src/domains/`
4. Update `src/core/domain-router.ts` to register it
5. Add tests in `tests/`
6. Submit a Pull Request

## 📄 License

MIT © wb_guozhongming
