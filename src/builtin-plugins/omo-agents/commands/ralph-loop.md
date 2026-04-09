---
description: "Start a self-referential development loop. The agent works continuously toward the goal until completion is detected (outputs 'RALPH LOOP COMPLETE'). Auto-continues if the agent stops without completing. Cancel with /stop-continuation."
---

Start a Ralph Loop for: $ARGUMENTS

## Ralph Loop Protocol

Work **continuously** toward the stated goal until it is **fully complete**. After each step:

1. **Check if the goal is achieved** — run tests, verify output, confirm the change works
2. **If DONE**: output `RALPH LOOP COMPLETE ✓` and stop
3. **If NOT DONE**: continue to the next step **immediately** without asking permission

### Rules
- **NEVER** stop to ask "should I continue?" — auto-proceed always
- **NEVER** stop because of a minor error — fix it and continue
- **ALWAYS** use parallel subagents where possible (explore, implement, verify simultaneously)
- Max iterations: 100 (counted internally via todo items)
- Use `/stop-continuation` to cancel early

### Completion Criteria
The loop ends when:
1. All todos are marked `completed`
2. Tests pass (if applicable)
3. The user's stated goal is verifiably met

Output `RALPH LOOP COMPLETE ✓` when done.
