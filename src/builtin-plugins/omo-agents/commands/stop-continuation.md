---
description: "Stop all continuation mechanisms for this session: ralph loop, todo-continuation-enforcer, ultrawork boulder mode. The agent completes the current action then stops and waits for explicit user instruction."
---

## STOP-CONTINUATION Activated

Immediately halt all active continuation loops for this session:

- **Ralph Loop**: cancelled ✗
- **Todo continuation enforcer**: suspended ✗
- **Ultrawork boulder mode**: deactivated ✗
- **Auto-proceed on completion**: disabled ✗

### What happens next

1. Complete the **current in-progress action** (finish the file edit / bash command you are already running)
2. **STOP** — do not process any pending todos automatically
3. **Wait** for explicit user instruction before continuing

### To resume
Simply send a new message with your next instruction. All mechanisms above will remain suspended until you start a new `/ralph-loop`, `/ultrawork`, or similar command.
