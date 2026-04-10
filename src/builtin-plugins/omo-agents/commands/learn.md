---
description: "Extract non-obvious learnings from this session and write to AGENTS.md files to build codebase understanding"
argument-hint: "[specific area or module to focus on]"
---

Analyze this session and extract non-obvious learnings to add to AGENTS.md files.

AGENTS.md files can exist at any directory level, not just the project root. When an agent reads a file, any AGENTS.md in parent directories are automatically loaded into the context of the tool read. Place learnings as close to the relevant code as possible:

- Project-wide learnings → root `AGENTS.md`
- Module-specific learnings → `src/<module>/AGENTS.md`
- Feature-specific learnings → `src/<module>/<feature>/AGENTS.md`

## What counts as a learning (non-obvious discoveries only)

- Hidden relationships between files or modules
- Execution paths that differ from how code appears
- Non-obvious configuration, env vars, or flags
- Debugging breakthroughs when error messages were misleading
- API/tool quirks and workarounds
- Build/test commands not in README
- Architectural decisions and constraints that aren't obvious from the code
- Files that must change together (coupling that isn't explicit)
- Gotchas with the plugin system, hooks, or agent frontmatter

## What NOT to include

- Obvious facts already documented in AGENTS.md
- Standard TypeScript/Node.js/Bun behavior
- Things already in an AGENTS.md file
- Verbose multi-paragraph explanations (keep to 1-3 lines per insight)
- Session-specific details (task names, PR numbers, timestamps)

## Process

1. Review this session for discoveries, errors that took multiple attempts, unexpected connections, or non-obvious behaviors
2. Determine scope — which directory does each learning apply to?
3. Read existing AGENTS.md files at the relevant levels (root, src/, src/module/, etc.)
4. Create or update AGENTS.md at the appropriate directory level
5. Keep entries to 1-3 lines per insight, formatted as bullet points

After updating, summarize which AGENTS.md files were created/updated and how many learnings were added per file.

$ARGUMENTS
