---
description: Fork the current session into a new independent session (copies conversation history)
argument-hint: "[new-session-title]"
---

Fork the current session into a new independent session so you can explore a different direction without losing the current conversation context.

Instructions:
1. Generate a new session ID using: `node -e "const {randomUUID}=require('crypto');console.log(randomUUID())"`
2. Use the SessionDB forkSession API to create the fork — run this Node.js snippet:

```bash
node -e "
const path = require('path');
const { randomUUID } = require('crypto');

// Find the SessionDB in the installed uagent
try {
  const homeDir = require('os').homedir();
  const sessionsDir = path.join(homeDir, '.uagent', 'sessions');
  const fs = require('fs');

  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions found yet.');
    process.exit(0);
  }

  const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, e.name, 'meta.json'), 'utf8'));
        return meta;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (dirs.length === 0) {
    console.log('No sessions found.');
    process.exit(0);
  }

  const latest = dirs[0];
  const newId = randomUUID();
  const newTitle = process.argv[1] || ('Fork of ' + (latest.title || latest.id.slice(0, 8)));

  // Copy session directory
  const srcDir = path.join(sessionsDir, latest.id);
  const dstDir = path.join(sessionsDir, newId);
  fs.mkdirSync(dstDir, { recursive: true });

  // Copy messages
  const msgSrc = path.join(srcDir, 'messages.jsonl');
  if (fs.existsSync(msgSrc)) {
    const lines = fs.readFileSync(msgSrc, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { const m = JSON.parse(l); m.sessionId = newId; return JSON.stringify(m); } catch { return null; } })
      .filter(Boolean);
    fs.writeFileSync(path.join(dstDir, 'messages.jsonl'), lines.join('\n') + '\n');
  }

  // Write meta
  const newMeta = { ...latest, id: newId, title: newTitle, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dstDir, 'meta.json'), JSON.stringify(newMeta, null, 2));

  console.log('✅ Session forked successfully!');
  console.log('New session ID: ' + newId);
  console.log('Title: ' + newTitle);
  console.log('Messages copied: ' + (newMeta.messageCount || 0));
  console.log('');
  console.log('To resume this forked session, use: uagent --resume ' + newId);
} catch (e) {
  console.error('Fork failed:', e.message);
}
" "$@"
```

3. Present the output to the user clearly, including the new session ID and instructions on how to resume the forked session.
4. Remind the user that the fork is independent — changes in one session don't affect the other.
