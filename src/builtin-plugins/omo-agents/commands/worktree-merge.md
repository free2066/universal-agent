---
description: "Merge the current sub-agent worktree changes back into the main branch. Use after a sub-agent has completed its work in a sandboxed worktree (requires UAGENT_WORKTREE=1). Shows a diff summary before merging."
argument-hint: "[session-id or leave empty for latest]"
allowed-tools: Bash, Read
---

Merge the sub-agent worktree changes back into the main branch.

!`echo "Worktrees directory: $(pwd)/.uagent-worktrees" && ls .uagent-worktrees/ 2>/dev/null || echo "No worktrees found (UAGENT_WORKTREE=1 must be set to create them)"`

## Instructions

1. **List active worktrees**:
   ```bash
   git worktree list
   ```

2. **If $ARGUMENTS is a session ID**, use that specific worktree. Otherwise use the most recently created one:
   ```bash
   ls -td .uagent-worktrees/*/ 2>/dev/null | head -1
   ```

3. **Show the diff** before merging:
   ```bash
   CURRENT=$(git rev-parse --abbrev-ref HEAD)
   BRANCH=$(git -C .uagent-worktrees/<session-id> rev-parse --abbrev-ref HEAD 2>/dev/null)
   git diff --stat $CURRENT...$BRANCH
   ```

4. **Confirm and merge**:
   ```bash
   git merge --no-ff $BRANCH -m "chore: merge ua worktree changes"
   ```

5. **Clean up the worktree** after successful merge:
   ```bash
   git worktree remove .uagent-worktrees/<session-id> --force
   git branch -D $BRANCH
   ```

Report the merge result including: files changed, insertions/deletions, and the branch name that was merged.
