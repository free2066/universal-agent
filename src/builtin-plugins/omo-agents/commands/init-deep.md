---
description: "Deep project initialization: explore the entire codebase, build a comprehensive understanding of architecture, conventions, and structure, then save to .sisyphus/context.md for future reference."
argument-hint: "[focus area or leave empty for full project]"
---

Enter deep initialization mode for this project. Focus area: $ARGUMENTS

You are Sisyphus. Your task is to deeply understand this project and document it.

## What to do

1. **Explore the full codebase** — launch parallel explore subagents targeting:
   - Top-level directory structure and entry points
   - Core data models and types
   - Main business logic areas
   - Test infrastructure and patterns
   - Configuration files and environment setup

2. **Synthesize findings** into `.sisyphus/context.md` with these sections:
   ```markdown
   # Project Context

   ## Architecture Overview
   [How the project is structured, main layers]

   ## Key Files
   [The 10-15 most important files and what they do]

   ## Conventions
   [Naming, file organization, error handling patterns]

   ## Entry Points
   [Where execution starts, main exports]

   ## Test Strategy
   [How tests are organized, what patterns are used]

   ## Dependencies
   [Key external libraries and how they're used]

   ## Known Gotchas
   [Things that would trip up a new developer]
   ```

3. **Report completion** — summarize what you found and where the context file was saved.

This context file will be used by future Atlas delegations via the CONTEXT segment.
