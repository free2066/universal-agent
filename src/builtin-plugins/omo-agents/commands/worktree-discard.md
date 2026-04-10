---
description: "Discard sub-agent worktree changes and remove the sandboxed worktree. Use when you want to throw away what a sub-agent did without merging it back. Requires UAGENT_WORKTREE=1."
argument-hint: "[session-id or leave empty for latest]"
allowed-tools: Bash
---

Discard the sub-agent worktree and remove all its changes.

!`git worktree list 2>/dev/null || echo "Not a git repository or no worktrees"`

## Instructions

1. **Identify the target worktree** from `$ARGUMENTS` (session ID) or list available ones:
   ```bash
   git worktree list
   ls .uagent-worktrees/ 2>/dev/null
   ```

2. **Show what will be discarded** (so the user can confirm):
   ```bash
   CURRENT=$(git rev-parse --abbrev-ref HEAD)
   BRANCH=$(git -C .uagent-worktrees/<id> rev-parse --abbrev-ref HEAD 2>/dev/null)
   git diff --stat $CURRENT...$BRANCH
   ```

3. **Remove the worktree and delete the branch**:
   ```bash
   git worktree remove .uagent-worktrees/<id> --force
   git branch -D $BRANCH
   git worktree prune
   ```

4. Confirm the cleanup is complete and list remaining worktrees.

Note: This is **irreversible** — all changes in the worktree will be permanently discarded.
