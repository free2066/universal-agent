---
description: Start an interactive terminal session managed by the Pty service
argument-hint: "[command]"
---

Start and interact with a terminal session via the Pty service.

**Note:** The Pty service requires `UAGENT_PTY=1` environment variable to be set. For most shell automation tasks, prefer using the Bash tool directly.

When a user asks to "open a terminal", "run an interactive process", or "start a shell session", use this guidance:

## For interactive processes (e.g., node REPL, python REPL):

Use the Bash tool with a timeout to run the command and capture output. For truly interactive sessions, advise the user to use their terminal directly.

## For the Pty service (UAGENT_PTY=1):

```javascript
// Create a pty session
const { getPtyService, isPtyEnabled } = require('./services/pty/index.js');

if (!isPtyEnabled()) {
  console.log('Pty service is disabled. Set UAGENT_PTY=1 to enable.');
} else {
  const pty = getPtyService();
  
  // Create a new terminal
  const info = pty.create({
    command: 'bash',
    args: ['-l'],
    cwd: process.cwd(),
  });
  
  console.log(`Terminal started: PID ${info.pid}, ID: ${info.id}`);
  
  // Write a command
  pty.write(info.id, 'echo "Hello from pty"\n');
  
  // Get buffered output after a delay
  setTimeout(() => {
    const output = pty.getBuffer(info.id);
    console.log('Output:', output);
    pty.kill(info.id);
  }, 1000);
}
```

## Available Pty operations:

| Operation | Description |
|-----------|-------------|
| `create({command, args, cwd, env, cols, rows})` | Start a new pty session |
| `write(id, data)` | Send input to pty |
| `resize(id, cols, rows)` | Resize the terminal |
| `kill(id)` | Terminate the pty |
| `getBuffer(id)` | Get all buffered output |
| `list()` | List all pty sessions |
| `onData(id, cb)` | Subscribe to output |
| `onExit(id, cb)` | Subscribe to exit event |

For most use cases, the Bash tool is simpler and more appropriate.
