---
description: "Generate a session handoff document capturing current state, completed work, pending tasks, and key decisions — so work can continue seamlessly in a new session."
---

Generate a handoff document for this session.

You are Sisyphus. Your task is to create a handoff summary that lets a future agent (or human) pick up exactly where this session left off.

## What to do

1. **Gather current state** — read in parallel:
   - Current todo list (all items and their status)
   - `.sisyphus/plans/` directory (any active plan files)
   - `.sisyphus/notepads/` directory (any accumulated learnings)
   - Recently modified files (last 10-20 git changes if available)

2. **Create handoff document** at `.sisyphus/handoff-{YYYY-MM-DD}.md`:
   ```markdown
   # Session Handoff — {date}

   ## What Was Accomplished
   [List of completed work items with brief description]

   ## Current State
   [What is the system doing right now? What works?]

   ## Pending Work
   [Incomplete todos, with enough context to continue]

   ## Active Plan
   [If there's a .sisyphus/plans/*.md — summarize it and note progress]

   ## Key Decisions Made
   [Architecture or design decisions with reasoning]

   ## Known Issues / Blockers
   [Anything that was discovered but not yet resolved]

   ## Where to Start Next Session
   [Specific first action the next agent/person should take]

   ## Important File Locations
   [Key files the next agent will need to read first]
   ```

3. **Tell the user** — "Handoff saved to `.sisyphus/handoff-{date}.md`. Share this path when starting your next session."
