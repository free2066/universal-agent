---
description: List all file snapshots for the current project (taken before each LLM turn and file edit)
---

List all snapshots saved by the universal-agent snapshot system for the current project directory.

Run the following shell command and show me the output:

```bash
PROJECT_HASH=$(python3 -c "import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])" "$(pwd)" 2>/dev/null || echo "")
SNAP_DIR="$HOME/.uagent/snapshots/$PROJECT_HASH"

if [ -z "$PROJECT_HASH" ] || [ ! -d "$SNAP_DIR" ]; then
  echo "No snapshots found for this project."
  echo "Snapshots are created automatically before each LLM turn and file edit."
  echo "Project hash would be at: ~/.uagent/snapshots/<hash>/"
else
  echo "## Snapshots for $(pwd)"
  echo ""
  SNAP_COUNT=$(git --git-dir="$SNAP_DIR" cat-file --batch-all-objects --batch-check 2>/dev/null | grep "^[0-9a-f]* tree" | wc -l | tr -d ' ')
  echo "Total tree objects: $SNAP_COUNT"
  echo ""
  echo "### Recent snapshots (trees, newest first):"
  git --git-dir="$SNAP_DIR" cat-file --batch-all-objects --batch-check 2>/dev/null \
    | grep "^[0-9a-f]* tree" \
    | awk '{print $1}' \
    | head -20 \
    | while read hash; do
        # Try to get the object creation time via the git log if it was committed
        echo "- \`$hash\`"
      done
  echo ""
  echo "To restore to a snapshot, run: /undo"
  echo "Or ask me: 'restore snapshot <hash>'"
fi
```

After running the command, present the results clearly. If there are snapshots, explain that:
- Each snapshot captures the entire project state (files up to 2MB)
- Snapshots are taken automatically before every LLM response and file edit
- Use `/undo` to restore the most recent pre-edit state
- Use `restore snapshot <hash>` to restore a specific snapshot
