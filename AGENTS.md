# universal-agent — Project Agent Instructions

## Overview

`universal-agent` (`uagent`) is a CLI that wraps the Claude Code core engine and extends it with:

- **Multi-LLM support**: Anthropic, Gemini, OpenAI, DeepSeek, Moonshot/Kimi, Qwen, Ollama, Groq, SiliconFlow, OpenRouter, 万擎 (Wanqing internal)
- **omo-agents plugin**: 11 specialized agents, 12 commands, 5 skills for multi-agent orchestration
- **Plugin system**: marketplace plugins, builtin plugins, fsBuiltin plugins
- **Hooks system**: pre/post tool use hooks, pre-compact hooks

Commands are `uagent` and `claude` (both point to same binary).

---

## Development Setup

```bash
# Install dependencies
bun install

# Development build (watch mode)
npm run dev

# Production build
npm run build

# Build output goes to dist/
```

**Version bump rule**: Always bump `package.json` version before publishing. Format: `1.2.X` where X increments by 1 each release. After bumping, run `npm run build` to rebuild, then commit and push.

**Build verification**: After any significant change, run `npm run build` and confirm "Bundled N modules in Xms" with no errors.

---

## Architecture Overview

```
src/
├── entrypoints/        # CLI entry points (cli.tsx → uagent/claude)
├── bootstrap/          # Startup state (UA model config injection)
├── models/             # Multi-LLM adapter layer
│   └── llm/            # Per-provider clients (factory.ts routes by prefix)
├── tools/              # All tool implementations
│   └── AgentTool/      # Core agent spawning (AgentTool.tsx, runAgent.ts, resumeAgent.ts)
├── skills/             # Skill loading system (loadSkillsDir.ts)
├── commands/           # Built-in slash commands (TypeScript, type: 'local')
├── plugins/            # Plugin registration (builtinPlugins.ts)
├── builtin-plugins/    # Bundled plugins shipped with CLI
│   └── omo-agents/     # Main multi-agent plugin
│       ├── agents/     # Agent definitions (Markdown frontmatter)
│       ├── commands/   # Slash commands (Markdown prompts)
│       ├── skills/     # Skills (SKILL.md files)
│       ├── hooks/      # hooks.json (pre/post tool use hooks)
│       └── mcp-server/ # Hashline read/edit MCP tools
├── services/           # Services: MCP client, plugins, OAuth, analytics
├── coordinator/        # Multi-agent coordinator/worker mode
├── state/              # AppState (Zustand-like store)
├── context/            # React contexts (notifications, voice, etc.)
└── hooks/              # React hooks (useReplBridge, useTypeahead, etc.)
```

---

## omo-agents Plugin

The main value-add of universal-agent. Located at `src/builtin-plugins/omo-agents/`.

### Agents (11 total)

| Agent | Role | Key Constraint |
|-------|------|----------------|
| **sisyphus** | Main orchestrator, intent gate, parallel dispatch | maxTurns: 100 |
| **atlas** | Plan executor, reads `.sisyphus/plans/` | maxTurns: 200 |
| **prometheus** | Strategic planner, interviews user | disallowedTools: Write, Edit |
| **oracle** | Architecture consultant, analysis only | tools: Read, Grep, Glob, LS, WebFetch, WebSearch, Skill |
| **explore** | Codebase scout, read-only | tools: Read, Grep, Glob, Bash, LS, WebFetch, WebSearch, Agent, Skill |
| **librarian** | External docs/library researcher | tools: Read, Glob, LS, WebFetch, WebSearch, Skill |
| **hephaestus** | Deep autonomous developer | maxTurns: 150 |
| **metis** | Gap analyst for plans | tools: Read, Grep, Glob, Bash, LS, Skill |
| **momus** | Plan quality reviewer, OKAY/REJECT | tools: Read, Grep, Glob, LS, Skill |
| **sisyphus-junior** | Task executor (no further delegation) | maxTurns: 30 |
| **multimodal-looker** | Visual/image analysis | tools: Read, Glob, LS, Skill |

### Commands (Markdown prompts, `src/builtin-plugins/omo-agents/commands/`)

Commands are Markdown files with YAML frontmatter. They are auto-discovered and registered as slash commands. To add a new command, create a `.md` file — no TypeScript changes needed.

Supported frontmatter fields: `description`, `argument-hint`, `allowed-tools`, `model`, `agent`

Shell injection: Use `` !`shell command` `` in the command body to inject real-time shell output into the prompt before sending to the LLM.

### Skills (Markdown, `src/builtin-plugins/omo-agents/skills/*/SKILL.md`)

Skills are injectable prompt templates. Each `SKILL.md` has YAML frontmatter (`name`, `description`). Skills are auto-discovered and also auto-registered as slash commands.

### Hooks (`src/builtin-plugins/omo-agents/hooks/hooks.json`)

All hooks use `type: "command"` with inline Node.js scripts (`node -e "..."`). The hooks cover:
- TodoWrite continuation enforcement
- LSP diagnostics reminder after file edits
- Context window monitoring (≥75% warning)
- Task session_id capture and error detection
- Bash dangerous command blocking
- Write-existing-file protection
- PreCompact 8-section structured summary injection

---

## Plugin System

Three plugin types:
- **builtin** (`{name}@builtin`): Bundled with CLI, user can toggle on/off via `/plugin`
- **marketplace** (`{name}@{marketplace}`): Installed from marketplace (e.g., `omc`)
- **fsBuiltin**: File-system level, cannot be overridden by session plugins

**Critical**: `fsBuiltin` plugins take priority over `session` plugins with the same name. The `mergePluginSources()` function in `pluginLoader.ts` enforces this — if an fsBuiltin and a session plugin share a name, the fsBuiltin wins silently.

---

## Model Configuration

User models configured in `~/.uagent/models.json`:
```json
{
  "pointers": { "main": "gemini-2.5-flash", "task": "...", "compact": "...", "quick": "..." },
  "profiles": [...],
  "router": {...},
  "fallback": [...]
}
```

Model routing in `src/models/llm/factory.ts` (by name prefix):
- `claude-*` → AnthropicClient
- `gemini-*` → GeminiClient
- `gpt-*` / default → OpenAIClient
- `wanqing/` or `ep-*` → OpenAIClient (compatible)
- `ollama:*` → OllamaClient

**Anthropic Prompt Caching**: AnthropicClient automatically injects `cache_control: {type: 'ephemeral'}` to system prompt tail and message tail. This uses the 5-minute KV Cache to reduce token costs.

---

## Key File Locations

| Purpose | Path |
|---------|------|
| CLI entry point | `src/entrypoints/cli.tsx` |
| Bootstrap (model injection) | `src/bootstrap/state.ts` |
| Agent tool (spawning) | `src/tools/AgentTool/AgentTool.tsx` |
| Agent resume | `src/tools/AgentTool/resumeAgent.ts` |
| Agent frontmatter parser | `src/tools/AgentTool/loadAgentsDir.ts` |
| Command registration | `src/commands.ts` (COMMANDS array) |
| Skill loading | `src/skills/loadSkillsDir.ts` |
| Plugin loader | `src/services/plugins/pluginLoader.ts` |
| Multi-LLM factory | `src/models/llm/factory.ts` |
| UA debug log | `~/.claude/debug/ua-debug.log` |
| Session log | `~/.uagent/logs/session-YYYY-MM-DD.log` |
| Error log | `~/.cache/claude-cli/<proj>/errors/*.jsonl` |

---

## Code Style

- TypeScript with strict mode
- Prefer `const` over `let`; avoid reassignment
- No `any` casts — find the correct type
- Single-word variable names preferred; multi-word only when necessary
- Avoid `else` — use early returns
- No unnecessary comments that restate what the code does
- No extra defensive checks in trusted codepaths
- No AI-generated boilerplate (see `/rmslop` command)
- Imports: ES module style (`import ... from '...'`)
- Feature flags: `feature('FLAG_NAME')` for dead-code elimination at build time

---

## Testing

```bash
# TypeScript type check only (no separate test runner)
npx tsc --noEmit

# Build verification
npm run build
```

There are no unit tests currently. Verification is done via build success + manual smoke testing.

---

## Important Constraints (DO NOT VIOLATE)

1. **Never `git push --force`** to main branch
2. **Never `git commit --amend`** if already pushed to remote
3. **Always run `npm run build`** before committing — confirm build succeeds
4. **Never modify `dist/`** directly — always edit `src/` and rebuild
5. **Never commit `node_modules/`** or `mcp-server/node_modules/`
6. **Version bump required** before every publish — `package.json` version field
7. **Feature flags**: Use `feature('FLAG')` gating for internal-only features; external builds perform dead-code elimination
8. **`fsBuiltin` plugin names** must be unique — collisions with session plugins cause silent overwrites

---

## Debugging

```bash
# View UA startup diagnostics
cat ~/.claude/debug/ua-debug.log

# View today's session log
cat ~/.uagent/logs/session-$(date +%Y-%m-%d).log

# Enable verbose debug logging
UA_DEBUG_LOG=~/ua-verbose.log uagent

# View recent errors
ls ~/.cache/claude-cli/*/errors/*.jsonl
```

---

## Multi-Agent Workflow (omo-agents)

The typical workflow for complex tasks:
1. **`/plan`** → Enters Prometheus planning mode → creates `.sisyphus/plans/<task>.md`
2. **`/start-work`** → Atlas reads the plan and dispatches tasks to workers
3. **`/ultrawork`** → Sisyphus maximum-parallel mode (skips planning for clear tasks)
4. **`/ralph-loop`** → Self-driving continuous execution until goal is complete

Agent session IDs: When a Task tool returns `session_id=<uuid>`, save it. You can resume that agent later using the `task_id` parameter in the Task tool to avoid re-spending context.
