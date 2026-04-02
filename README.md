# universal-agent

> 🤖 A universal multi-domain AI Agent CLI — supports data analysis, programming, customer service, and advanced multi-agent orchestration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)

---

## Features

### Core Agent Engine
- **Multi-domain routing** — auto-detects task type (data / dev / service) and activates domain-specific tools
- **Streaming responses** — real-time token streaming for long-running tasks
- **Safe mode** — `--safe` flag prevents destructive file/shell operations
- **Model fallback chain** — automatically retries with backup models on failure
- **Context compressor** — auto-compacts long conversations to stay within token limits
- **Schema-validated tools** — all tool calls are validated against JSON Schema before execution

### Multi-Agent Orchestration
- **`SpawnAgent`** — spawn isolated sub-agents with scratchpad context handoff; prevents recursive spawning via `SPAWN_DEPTH` env guard
- **`SpawnParallel`** — run multiple worker agents concurrently, collect and merge results
- **`CoordinatorRun`** — full 5-phase pipeline: Research → Synthesis → Critic Review → Implementation → Verification
  - Actor-Critic pattern: independent Critic agent audits synthesis plans before implementation
  - Human-in-the-Loop checkpoints: pause pipeline after any phase, serialize state, resume with `resume_from`
  - Permission Bridge: workers declare dangerous operations (`PERMISSION_REQUEST:`) instead of executing them; coordinator surfaces requests for user approval
  - Mailbox messaging: structured point-to-point and broadcast messaging between agents via `.uagent/mailbox/`
- **`BusinessDefectDetect`** — 5-stage serial pipeline for business logic defect detection (inspired by kstack #15360):
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

### Skill System (Dual Paradigm — kstack #15366)
- **`load_skill`** — Prompt Paradigm: loads SKILL.md body into context, model interprets and executes freely
- **`run_skill`** — Program Paradigm: system-controlled step execution with per-step completion gates, prevents model drift and early exits
- Skills declared with `mode: program` + `steps[]` + `completion_gate` in YAML frontmatter
- `degrees_of_freedom: high|medium|low` guides paradigm selection

### Collaboration & Productivity
- **Teammate system** — spawn persistent teammate agents, send/receive inbox messages, broadcast to all teammates
- **Worktree tools** — create git worktrees for parallel feature development, bind tasks to worktrees
- **Task board** — persistent task tracking across sessions with claim/assign/complete workflow
- **Background tasks** — run long shell commands in background, check status asynchronously
- **Todo tracking** — in-session todo management with progress reminders

### Infrastructure
- **Memory store** — semantic memory with MMR (Maximal Marginal Relevance) deduplication
- **MCP integration** — Model Context Protocol support for external tool servers
- **Domain plugins** — data / dev / service domain plugins with specialized tools and system prompts
- **Skill loader** — `.uagent/skills/<name>/SKILL.md` on-demand knowledge injection (Layer 1: descriptions in system prompt, Layer 2: full body on demand)

---

## Project Structure

```
src/
├── cli/                        # CLI entry layer
│   ├── index.ts                # Main CLI & REPL
│   └── ui-enhanced.ts          # Terminal UI components
│
├── core/                       # Core agent engine
│   ├── agent.ts                # AgentCore — main loop, tool dispatch, streaming
│   ├── tool-registry.ts        # Schema-validated tool registry
│   ├── domain-router.ts        # Domain auto-detection
│   ├── subagent-system.ts      # Sub-agent lifecycle management
│   ├── teammate-manager.ts     # Persistent teammate agents
│   ├── task-board.ts           # Cross-session task tracking
│   ├── model-fallback.ts       # Fallback chain
│   ├── tool-selector.ts        # Semantic tool selection
│   ├── tool-retry.ts           # Retry decorator
│   ├── hooks.ts                # Lifecycle hooks
│   ├── logger.ts               # Structured logger
│   │
│   ├── context/                # Context management
│   │   ├── context-loader.ts   # AGENTS.md / rules / skill descriptions
│   │   ├── context-compressor.ts # Auto-compact long conversations
│   │   └── context-editor.ts   # Selective context editing
│   │
│   ├── memory/                 # Semantic memory
│   │   ├── memory-store.ts     # Embedding-based memory store
│   │   ├── memory-search.ts    # MMR-based search
│   │   ├── mmr.ts              # Maximal Marginal Relevance
│   │   └── session-history.ts  # Session history persistence
│   │
│   ├── skills/                 # Skill system
│   │   └── skill-loader.ts     # SKILL.md parser + ProgramSkillRunner
│   │
│   └── tools/                  # Tool implementations
│       ├── fs/                 # File system tools
│       │   └── fs-tools.ts     # read/write/edit/bash/list/grep
│       ├── web/                # Network tools
│       │   └── web-tools.ts    # fetch/search
│       ├── code/               # Code quality tools
│       │   ├── ai-reviewer.ts          # P1/P2/P3 review + Four-Dimension
│       │   ├── code-inspector.ts       # Static analysis
│       │   ├── self-heal.ts            # Auto-fix errors
│       │   ├── spec-generator.ts       # Test/impl spec generation
│       │   ├── reverse-analyze.ts      # Architecture reverse-engineering
│       │   └── business-defect-detector.ts  # 5-stage business defect pipeline
│       ├── agents/             # Multi-agent tools
│       │   ├── spawn-agent.ts          # SpawnAgent + Mailbox system
│       │   ├── coordinator-tool.ts     # CoordinatorRun 5-phase pipeline
│       │   └── worktree-tools.ts       # Git worktree management
│       └── productivity/       # Productivity tools
│           ├── todo-tool.ts            # In-session todo tracking
│           ├── background-tools.ts     # Background command execution
│           └── skill-tool.ts           # load_skill + run_skill
│
├── models/                     # LLM abstraction layer
│   ├── types.ts                # Core type definitions
│   ├── model-manager.ts        # Model registry (main/quick/embedding)
│   └── llm-client.ts           # OpenAI / Anthropic / compatible clients
│
└── domains/                    # Domain plugins
    ├── data/                   # Data analysis (SQL, CSV, EDA, schema)
    ├── dev/                    # Development (code review, git, execute)
    └── service/                # Customer service (FAQ, sentiment, tickets)
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

Create a `.env` file in your project root:

```env
# Required: at least one LLM provider
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: custom base URL (for compatible APIs)
OPENAI_BASE_URL=https://api.openai.com/v1

# Optional: model selection
UAGENT_MODEL=claude-3-5-sonnet-20241022
UAGENT_QUICK_MODEL=claude-3-haiku-20240307
```

### Usage

```bash
# Interactive REPL
uagent

# Single command
uagent "Analyze the performance of the checkout flow"

# Specify domain explicitly
uagent --domain data "Query sales by region for last month"
uagent --domain dev  "Review the auth module for security issues"

# Code review
uagent review           # review git diff
uagent review src/      # review a directory

# Safe mode (no destructive operations)
uagent --safe "Refactor the user service"

# Verbose mode
uagent --verbose "Debug the payment integration"
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `/review [path\|--diff]` | Run AI code review |
| `/inspect [path]` | Static code inspection |
| `/heal [path]` | Auto-fix TypeScript/lint errors |
| `/spec [path]` | Generate test specifications |
| `/memory search <query>` | Search semantic memory |
| `/skill list` | List available skills |
| `/task list` | Show task board |
| `/compact` | Compress conversation history |
| `/clear` | Clear conversation |
| `/exit` | Exit REPL |

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

---

## Engineering Patterns

This project implements several advanced multi-agent patterns sourced from engineering research:

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
