---
description: "List recent saved sessions from ~/.uagent/sessions/. Shows session ID, title, model, date, and message count. Use to review past work or resume a previous conversation context."
argument-hint: "[limit: number of sessions to show, default 20]"
allowed-tools: Bash, Read
---

List recent saved sessions from the session history.

!`ls ~/.uagent/sessions/ 2>/dev/null | wc -l | xargs echo "Total sessions:"`

## Instructions

1. **Read session metadata files** from `~/.uagent/sessions/`:
   ```bash
   for dir in ~/.uagent/sessions/*/; do
     if [ -f "$dir/meta.json" ]; then
       cat "$dir/meta.json"
       echo "---"
     fi
   done | head -200
   ```

2. **Format and display** the sessions as a readable table (newest first):

   | # | Session ID | Title | Model | Last Updated | Messages |
   |---|-----------|-------|-------|--------------|----------|

3. **If $ARGUMENTS is a number**, limit the output to that many sessions (default: 20).

4. After displaying the list, inform the user they can:
   - Run `/resume <session-id>` to load a previous session's context
   - Run `/share` to export the current session

If no sessions exist yet, explain that sessions are saved automatically once session persistence is configured.
