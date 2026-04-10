---
description: "Undo the last AI file edit(s) by restoring the pre-edit snapshot. Uses the git-based snapshot system to revert files to their state before the most recent write or edit operation. Safe to run multiple times."
argument-hint: "[optional: path to specific file to undo]"
allowed-tools: Bash, Read
---

Undo the last AI file edit by restoring the pre-edit snapshot.

!`echo "Project root: $(pwd)" && ls ~/.uagent/snapshots/ 2>/dev/null | head -5 || echo "No snapshots yet"`

## Instructions

The snapshot system automatically captures the project state before every file write or edit. To undo:

1. **If a specific file is mentioned** (`$ARGUMENTS`), restore only that file:
   ```bash
   # The snapshot service restores via git read-tree
   # For manual recovery, check git history in ~/.uagent/snapshots/
   ls ~/.uagent/snapshots/*/
   ```

2. **For full undo** (revert all changes from last AI session edit):
   ```bash
   # List available snapshots
   SNAP_DIR=$(ls -td ~/.uagent/snapshots/*/ 2>/dev/null | head -1)
   if [ -n "$SNAP_DIR" ]; then
     echo "Found snapshot dir: $SNAP_DIR"
     git --git-dir="$SNAP_DIR" log --oneline 2>/dev/null | head -10 || echo "No git history yet"
   else
     echo "No snapshot directory found. Snapshots are created automatically on first edit."
   fi
   ```

3. **Report what was undone**: List the files that were restored and their previous state.

If no snapshot exists yet (first session), explain that snapshots are created automatically starting from the next file edit.

If `$ARGUMENTS` specifies a file, focus the undo on that specific file only.
