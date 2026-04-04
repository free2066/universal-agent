# universal-agent

> 🤖 A universal multi-domain AI Agent CLI — supports data analysis, programming, customer service, and advanced multi-agent orchestration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/version-0.2.0-orange)](package.json)

---

## Features

### Core Agent Engine
- **Multi-domain routing** — auto-detects task type (data / dev / service) and activates domain-specific tools
- **Streaming responses** — real-time token streaming for long-running tasks
- **Safe mode** — `--safe` flag prevents destructive file/shell operations
- **Model fallback chain** — automatically retries with backup models on failure
- **Context compressor** — auto-compacts long conversations to stay within token limits
- **Schema-validated tools** — all tool calls are validated against JSON Schema before execution
- **Extended thinking** — `--thinking low|medium|high|max` for Claude models; toggle live with `Ctrl+T` in REPL

### Multi-Agent Orchestration
- **`SpawnAgent`** — spawn isolated sub-agents with scratchpad context handoff; prevents recursive spawning via `SPAWN_DEPTH` env guard
- **`SpawnParallel`** — run multiple worker agents concurrently, collect and merge results
- **`CoordinatorRun`** — full 5-phase pipeline: Research → Synthesis → Critic Review → Implementation → Verification
  - Actor-Critic pattern: independent Critic agent audits synthesis plans before implementation
  - Human-in-the-Loop checkpoints: pause pipeline after any phase, serialize state, resume with `resume_from`
  - Permission Bridge: workers declare dangerous operations (`PERMISSION_REQUEST:`) instead of executing them; coordinator surfaces requests for user approval
  - Mailbox messaging: structured point-to-point and broadcast messaging between agents via `.uagent/mailbox/`
- **`BusinessDefectDetect`** — 5-stage serial pipeline for business logic defect detection:
  - Stage 1: Architecture analysis → module map
  - Stage 2: PRD/TRD requirements extraction → structured business rules
  - Stage 3: Business rule → code entity mapping (traceability chain)
  - Stage 4: Function-level git diff analysis with risk notes
  - Stage 5: Multi-source evidence reasoning → P0/P1/P2/P3 defect report

### Code Quality Tools
- **`AIReview`** — P1/P2/P3 graded code review with Four-Dimension quality framework (business / coverage / scenario / executability)
- **`CodeInspect`** — static analysis: dead code, complexity, security patterns, dependency issues
- **`SelfHeal`** — auto-detects and fixes TypeScript/lint errors in a retry loop
- **`SpecGenerate`** — generates test specs and implementation specs from code
- **`ReverseAnalyze`** — reverse-engineers architecture from codebase, produces AGENTS.md

### Skill System (Dual Paradigm)
- **`load_skill`** — Prompt Paradigm: loads SKILL.md body into context, model interprets and executes freely
- **`run_skill`** — Program Paradigm: system-controlled step execution with per-step completion gates, prevents model drift and early exits
- Skills declared with `mode: program` + `steps[]` + `completion_gate` in YAML frontmatter
- `degrees_of_freedom: high|medium|low` guides paradigm selection

### Collaboration & Productivity
- **Teammate system** — spawn persistent teammate agents, send/receive inbox messages, broadcast to all teammates
- **Worktree tools** — create git worktrees for parallel feature development, bind tasks to worktrees
- **Task board** — persistent task tracking across sessions with claim/assign/complete workflow
- **Background tasks** — run long shell commands in background; `kill_bash` to terminate any running task
- **Todo tracking** — in-session todo management with progress reminders

### MCP Integration
- **stdio / SSE / HTTP** server types supported
- **`uagent mcp`** — full CRUD CLI: `list | add | remove | enable | disable | get | test | init | templates`
- **`/mcp`** REPL command — shows server status + active tools for the current session
- **`--mcp-config <json|file>`** — inject a one-shot MCP config at launch without writing to disk
- **`--browser`** — automatically activates the Playwright MCP server (if configured) for browser automation

### Configuration & Persistence
- **Layered config** (`~/.codeflicker/config.json` → `.codeflicker/config.json`) — persistent defaults for model, language, approvalMode, thinking, notification, etc.
- **`uagent config`** — `ls | get | set [-g] | add | rm | migrate` sub-commands
- **`config migrate`** — import preferences from CodeFlicker IDE / KwaiPilot settings
- **Rules system** — `.uagent/rules/*.md` files are injected into every system prompt; `/rules` REPL command lists loaded files
- **Session snapshots** — full conversation history saved to `~/.uagent/sessions/`; resume any session by ID with `-r <id>`
- **Session logging** — HTML session logs in `~/.uagent/logs/`; view with `uagent log`

### Web Search
- **Google Custom Search API** — when `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` are set, uses Google for search
- **DuckDuckGo fallback** — automatically falls back when Google credentials are absent

### Infrastructure & Security
- **Memory store** — semantic memory with MMR (Maximal Marginal Relevance) deduplication
- **Domain plugins** — data / dev / service domain plugins with specialized tools and system prompts
- **Skill loader** — `.uagent/skills/<name>/SKILL.md` on-demand knowledge injection
- **Path security** — all file operations validated against allowed directories (path traversal protection)
- **Shell injection prevention** — user-provided strings passed as arguments, never interpolated into shell strings
- **Secret scanner** — detects API keys / tokens before writing files
- **Auto-update** — checks for new commits on startup, pulls + rebuilds automatically

---

## Project Structure

```
src/
├── cli/                        # CLI entry layer
│   ├── index.ts                # Main CLI & REPL (chat command + all global options)
│   ├── commit.ts               # uagent commit — AI commit message generation
│   ├── shell.ts                # uagent run — NL → shell command
│   ├── log.ts                  # uagent log — session history viewer
│   ├── repl/
│   │   ├── repl.ts             # REPL main loop
│   │   └── slash-handlers.ts   # /xxx slash command handlers
│   ├── commands/
│   │   ├── cmd-misc.ts         # run, config, commit, workspace, inspect, purify …
│   │   ├── cmd-models.ts       # uagent models list/add/set/remove
│   │   ├── cmd-mcp.ts          # uagent mcp list/add/enable/disable/test …
│   │   ├── cmd-memory.ts       # uagent memory list/add/search/ingest/gc
│   │   ├── cmd-schema.ts       # uagent schema list/search/init
│   │   └── cmd-spec.ts         # uagent spec new/list/show
│   ├── config-store.ts         # Layered JSON config (global + project)
│   ├── session-logger.ts       # HTML session log writer
│   ├── auto-update.ts          # Git-based auto-update
│   └── ui-enhanced.ts          # Terminal UI components
│
├── core/                       # Core agent engine
│   ├── agent.ts                # AgentCore — main loop, tool dispatch, streaming
│   ├── tool-registry.ts        # Schema-validated tool registry
│   ├── domain-router.ts        # Domain auto-detection
│   ├── subagent-system.ts      # Sub-agent lifecycle management
│   ├── teammate-manager.ts     # Persistent teammate agents
│   ├── task-board.ts           # Cross-session task tracking
│   ├── mcp-manager.ts          # MCP server manager (stdio/SSE/HTTP)
│   ├── background-manager.ts   # Background process tracking + kill
│   ├── hooks.ts                # Lifecycle hooks
│   │
│   ├── context/                # Context management
│   │   ├── context-loader.ts   # AGENTS.md / rules / skill descriptions
│   │   ├── context-compressor.ts # Auto-compact long conversations
│   │   └── context-editor.ts   # Selective context editing
│   │
│   ├── memory/                 # Session & semantic memory
│   │   ├── memory-store.ts     # Embedding-based memory store
│   │   ├── session-history.ts  # Per-session prompt history (JSONL)
│   │   └── session-snapshot.ts # Full Message[] snapshots for resume
│   │
│   ├── skills/                 # Skill system
│   │   └── skill-loader.ts     # SKILL.md parser + ProgramSkillRunner
│   │
│   └── tools/                  # Tool implementations
│       ├── fs/                 # File system tools
│       │   └── fs-tools.ts     # read/write/edit/bash/list/grep
│       ├── web/                # Network tools
│       │   └── web-tools.ts    # web_fetch / web_search (Google → DuckDuckGo)
│       ├── code/               # Code quality tools
│       │   ├── ai-reviewer.ts
│       │   ├── code-inspector.ts
│       │   ├── self-heal.ts
│       │   ├── spec-generator.ts
│       │   ├── reverse-analyze.ts
│       │   └── business-defect-detector.ts
│       ├── agents/             # Multi-agent tools
│       │   ├── spawn-agent.ts
│       │   ├── coordinator-tool.ts
│       │   └── worktree-tools.ts  # WorktreeManager (exported)
│       └── productivity/       # Productivity tools
│           ├── todo-tool.ts
│           ├── background-tools.ts  # background_run + kill_bash
│           └── skill-tool.ts
│
├── models/                     # LLM abstraction layer
│   ├── types.ts                # Core type definitions
│   ├── model-manager.ts        # Model registry (main/task/quick/compact/embedding)
│   └── llm-client.ts           # OpenAI / Anthropic / compatible clients
│
└── domains/                    # Domain plugins
    ├── data/
    ├── dev/
    └── service/
```

---

## Quick Start

### Installation

```bash
npm install
npm run build
npm link   # makes `uagent` available globally
```

### Configuration

```bash
# Interactive API key setup wizard
uagent config

# Or create ~/.uagent/.env manually:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Google Search (fallback: DuckDuckGo)
GOOGLE_API_KEY=...
GOOGLE_CSE_ID=...
```

Persistent settings (survive restarts) via config file:

```bash
uagent config set model claude-3-5-sonnet-20241022
uagent config set language Chinese
uagent config set approvalMode autoEdit
uagent config set thinkingLevel medium
uagent config set -g notification true   # global: play sound on session end
```

---

## CLI Reference

### Default command — interactive REPL

```bash
uagent                             # start interactive session
uagent "explain this project"      # start with initial prompt
uagent -q "summarize README.md"    # quiet / one-shot mode
```

### Global options

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Main model to use |
| `--plan-model <model>` | Model for complex planning tasks |
| `--small-model <model>` | Fast/cheap model for quick operations |
| `--vision-model <model>` | Vision-capable model for image tasks |
| `-q, --quiet` | Non-interactive one-shot mode |
| `-c, --continue` | Resume last session |
| `-r, --resume <id>` | Resume specific session by ID (`uagent log` to list) |
| `--output-style <style>` | Style preset (`Concise`/`Explanatory`/`Formal`/`Casual`), file path, or JSON |
| `--thinking <level>` | Extended thinking: `low\|medium\|high\|max\|xhigh` |
| `--approval-mode <mode>` | `default\|autoEdit\|yolo` |
| `--tools <json>` | Disable tools: `'{"bash":false,"write":false}'` |
| `--mcp-config <json\|file>` | One-shot MCP config (not persisted) |
| `--browser` | Enable browser integration via Playwright MCP |
| `--language <lang>` | Response language (e.g. `Chinese`) |
| `--system-prompt <text>` | Override system prompt |
| `--append-system-prompt <text>` | Append to system prompt |
| `--cwd <path>` | Set working directory |
| `--safe` | Safe mode — block destructive operations |
| `-v, --verbose` | Show tool call details |

### Sub-commands

```bash
# Git commit with AI-generated message
uagent commit [-s] [-c] [--push] [-n] [--checkout] [--follow-style] [--language Chinese]

# Natural language → shell command
uagent run [-y] [--copy] [--explain] [--safe]

# Workspace / git worktrees (alias: ws)
uagent workspace list
uagent ws create <name> [-t <taskId>] [-b <baseRef>]
uagent ws remove <name> [--force] [--complete]
uagent ws status <name>
uagent ws events [-n <limit>]

# MCP servers
uagent mcp list
uagent mcp add --name <n> --command <cmd> --args <args>
uagent mcp enable|disable|remove|get|test <name>
uagent mcp init [--templates]

# Configuration
uagent config ls
uagent config get <key>
uagent config set [-g] <key> <value>
uagent config migrate          # import from CodeFlicker IDE / KwaiPilot

# Models
uagent models list
uagent models set main <model>
uagent models add <name> --model-name <id> --provider <p>

# Memory
uagent memory list|add|search|delete|ingest|gc|clear

# Code quality
uagent review [path] [--diff <ref>]
uagent inspect [path] [-s warning|error|critical]
uagent purify [path] [-d] [--commit]

# Misc
uagent log [-n <count>] [--id <id>]
uagent spec new "<description>"
uagent schema search "<query>"
uagent update
uagent debug [--ping] [--json]
uagent usage [--days 7]
```

### REPL slash commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/mcp` | Show MCP server status + active tools |
| `/rules` | List loaded rules files |
| `/review [path]` | Run AI code review |
| `/inspect [path]` | Static code inspection |
| `/purify [path]` | Auto-fix errors |
| `/model <name>` | Switch model mid-session |
| `/resume` | Restore last session snapshot |
| `/compact` | Compress conversation history |
| `/tokens` | Show token usage |
| `/cost` | Show estimated cost |
| `/history` | Show REPL input history |
| `/clear` | Clear conversation |
| `/exit` | Exit REPL |

### REPL keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+T` | Cycle thinking level: off → low → medium → high → off |
| `Ctrl+R` | Reverse history search |
| `Ctrl+C` | Interrupt / exit |
| `Tab` | Autocomplete slash commands |

---

## Advanced Features

### Multi-Agent Coordination

```
# In the REPL or as a prompt:
CoordinatorRun({
  goal: "Refactor the auth module to use JWT",
  scratchpad_id: "auth-refactor",
  flow_config: {
    human_checkpoints: ["research"],   # pause after research phase
    skip_critic: false,                # keep Actor-Critic review
    max_parallel: 3
  }
})
```

### Business Defect Detection

```
BusinessDefectDetect({
  prd_text: "Users must be notified within 30 minutes of order status change...",
  staged_only: true    # only check staged git changes
})
```

### Program-Mode Skills

Create `.uagent/skills/page-explorer/SKILL.md`:

```yaml
---
name: page-explorer
description: Explore and verify a web page in strict sequence
mode: program
degrees_of_freedom: low
steps:
  - id: open
    prompt: "Open the target URL and take a screenshot"
    required_output: "screenshot"
  - id: verify
    prompt: "Verify the page loaded correctly by checking title and key elements"
    required_output: "verification"
  - id: explore
    prompt: "Explore interactive elements and document all findings"
    required_output: "findings"
completion_gate: "All steps completed and all required_outputs present"
---
Global context for all steps...
```

Then call: `run_skill({ name: "page-explorer", context: "URL: https://..." })`

### MCP One-Shot Config

```bash
# Inject servers for a single session without touching .mcp.json
uagent --mcp-config '{"mcpServers":{"mydb":{"type":"stdio","command":"npx","args":["-y","@mcp/postgres","postgresql://localhost/mydb"]}}}' "query the users table"

# Or point to a file
uagent --mcp-config ./my-mcp.json "task"
```

### Output Style

```bash
uagent --output-style Concise "explain this"          # built-in preset
uagent --output-style ./style.md "review code"        # load from file
uagent --output-style '{"prompt":"Be very brief"}' "explain"  # inline JSON
```

---

## Engineering Patterns

| Pattern | Source | Implementation |
|---------|--------|----------------|
| Actor-Critic review loop | kstack #15345 | `coordinator-tool.ts` — Critic phase before implementation |
| Dead code filter | kstack #15347 | `coordinator-tool.ts` — Phase 0 LLM-based task filtering |
| Four-Dimension quality framework | kstack #15347 | `ai-reviewer.ts` — business/coverage/scenario/executability |
| Mailbox message routing | kstack #15348 | `spawn-agent.ts` — typed point-to-point + broadcast |
| Permission Bridge | kstack #15348 | `coordinator-tool.ts` — worker permission request protocol |
| Human-in-the-Loop checkpoints | kstack #15348 | `coordinator-tool.ts` — pause/resume with state serialization |
| Business defect detection | kstack #15360 | `business-defect-detector.ts` — 5-stage evidence chain pipeline |
| Skill as Program paradigm | kstack #15366 | `skill-loader.ts` + `skill-tool.ts` — ProgramSkillRunner with completion gates |

---

## Changelog

### v0.2.0
- `--plan-model` / `--small-model` / `--vision-model` global options
- `-r / --resume <id>` — resume any session by ID
- `--output-style` — named presets, file, or inline JSON
- `--mcp-config` — one-shot MCP injection without writing to disk
- `--browser` — auto-activate Playwright MCP for browser tasks
- `uagent workspace` (`ws`) — full git worktree CLI
- `uagent commit --checkout` — create branch before committing
- `Ctrl+T` REPL shortcut — cycle thinking level
- `/mcp` REPL command — server status + active tools
- Google Custom Search API support (fallback: DuckDuckGo)
- `kill_bash` tool — terminate background tasks
- `config migrate` — import from CodeFlicker IDE / KwaiPilot
- Session HTML logging (`uagent log`)
- Auto-update: `git pull → npm install → npm run build`
- Security: path traversal fix, shell injection prevention, secret scanner
- `WorktreeManager` exported for CLI use

### v0.1.0
- Initial release: multi-domain agent, multi-agent orchestration, code quality tools, skill system, MCP integration

---

## Development

```bash
# Development mode (no build required)
npm run dev

# Build
npm run build

# Type check only
npx tsc --noEmit

# Lint
npm run lint

# Test
npm test
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
