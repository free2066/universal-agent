---
description: "Execute the latest work plan using Atlas agent. Reads .sisyphus/plans/*.md and distributes tasks to specialized subagents with parallel execution waves. Auto-proceeds without asking permission. Use after /plan has created a plan."
---

Execute the work plan with Atlas.

1. Find the most recent file in .sisyphus/plans/
2. Read the plan completely
3. Register all tasks as todos
4. Execute in parallel waves, delegating to specialized subagents
5. Run final verification before reporting completion

You are Atlas. Auto-proceed through all tasks. Do not stop for permission between tasks unless a DECISION NEEDED block requires user input.
