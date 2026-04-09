---
name: work-with-pr
description: "Full PR lifecycle: git worktree → implement → atomic commits → PR creation → verification loop (CI + review-work) → merge. Keeps iterating until ALL gates pass and PR is merged. Worktree auto-cleanup after merge. Use whenever implementation work needs to land as a PR. Triggers: 'create a PR', 'implement and PR', 'work on this and make a PR', 'implement issue', 'land this as a PR', 'work-with-pr', 'PR workflow', 'implement end to end', even when user just says 'implement X' if the context implies PR delivery."
---

# Work With PR — Full PR Lifecycle

You are executing a complete PR lifecycle: from isolated worktree setup through implementation, PR creation, and an unbounded verification loop until the PR is merged. The loop has two gates — CI and review-work — and you keep fixing and pushing until both pass simultaneously.

<architecture>

```
Phase 0: Setup         → Branch + worktree in sibling directory
Phase 1: Implement     → Do the work, atomic commits
Phase 2: PR Creation   → Push, create PR targeting main/dev
Phase 3: Verify Loop   → Unbounded iteration until ALL gates pass:
  ├─ Gate A: CI         → gh pr checks (tests, typecheck, build)
  └─ Gate B: review-work → 5-agent parallel review
Phase 4: Merge         → Squash merge, worktree cleanup
```

</architecture>

---

## Phase 0: Setup

Create an isolated worktree so the user's main working directory stays clean. This matters because the user may have uncommitted work, and checking out a branch would destroy it.

<setup>

### 1. Resolve repository context

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "unknown/unknown")
REPO_NAME=$(basename "$PWD")
# Detect base branch (prefer 'dev' if exists, fall back to 'main' or 'master')
BASE_BRANCH=$(git branch -r | grep -E 'origin/(dev|main|master)' | head -1 | sed 's|origin/||' | tr -d ' ')
ORIGINAL_DIR="$PWD"
```

### 2. Create branch

If user provides a branch name, use it. Otherwise, derive from the task:

```bash
# Auto-generate: feature/short-description or fix/short-description
BRANCH_NAME="feature/$(echo "$TASK_SUMMARY" | tr '[:upper:] ' '[:lower:]-' | head -c 50)"
git fetch origin "$BASE_BRANCH"
git branch "$BRANCH_NAME" "origin/$BASE_BRANCH"
```

### 3. Create worktree

Place worktrees as siblings to the repo — not inside it. This avoids git nested repo issues and keeps the working tree clean.

```bash
WORKTREE_PATH="../${REPO_NAME}-wt/${BRANCH_NAME}"
mkdir -p "$(dirname "$WORKTREE_PATH")"
git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
```

### 4. Set working context

All subsequent work happens inside the worktree. Install dependencies if needed:

```bash
cd "$WORKTREE_PATH"
# Detect package manager and install
if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
  bun install
elif [ -f "package-lock.json" ]; then
  npm install
elif [ -f "yarn.lock" ]; then
  yarn install
elif [ -f "pnpm-lock.yaml" ]; then
  pnpm install
fi
```

</setup>

---

## Phase 1: Implement

Do the actual implementation work inside the worktree. The agent using this skill does the work directly — no subagent delegation for the implementation itself.

**Scope discipline**: For bug fixes, stay minimal. Fix the bug, add a test for it, done. Do not refactor surrounding code, add config options, or "improve" things that aren't broken. The verification loop will catch regressions — trust the process.

<implementation>

### Commit strategy

Use the git-master skill's atomic commit principles. The reason for atomic commits: if CI fails on one change, you can isolate and fix it without unwinding everything.

```
3+ files changed  → 2+ commits minimum
5+ files changed  → 3+ commits minimum
10+ files changed → 5+ commits minimum
```

Each commit should pair implementation with its tests. Load `git-master` skill when committing:

```
task(category="quick", load_skills=["git-master"], prompt="Commit the changes atomically following git-master conventions. Repository is at {WORKTREE_PATH}.")
```

### Pre-push local validation

Before pushing, run the same checks CI will run. Catching failures locally saves a full CI round-trip:

```bash
# Detect and run appropriate test/build commands
if [ -f "package.json" ]; then
  # TypeScript projects
  npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null || true
  npm test 2>/dev/null || true
  npm run build 2>/dev/null || true
fi
```

Fix any failures before pushing. Each fix-commit cycle should be atomic.

</implementation>

---

## Phase 2: PR Creation

<pr_creation>

### Push and create PR

```bash
git push -u origin "$BRANCH_NAME"
```

Create the PR:

```bash
gh pr create \
  --base "$BASE_BRANCH" \
  --head "$BRANCH_NAME" \
  --title "$PR_TITLE" \
  --body "$(cat <<'EOF'
## Summary
[1-3 sentences describing what this PR does and why]

## Changes
[Bullet list of key changes]

## Testing
- Build: ✅
- Tests: ✅
- Type check: ✅

## Related Issues
[Link to issue if applicable]
EOF
)"
```

Capture the PR number:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
```

</pr_creation>

---

## Phase 3: Verification Loop

This is the core of the skill. Two gates must ALL pass for the PR to be ready. The loop has no iteration cap — keep going until done. Gate ordering is intentional: CI is cheapest/fastest, review-work is most thorough.

<verify_loop>

```
while true:
  1. Wait for CI          → Gate A
  2. If CI fails          → read logs, fix, commit, push, continue
  3. Run review-work      → Gate B
  4. If review fails      → fix blocking issues, commit, push, continue
  5. Both pass            → break
```

### Gate A: CI Checks

CI is the fastest feedback loop. Wait for it to complete, then parse results.

```bash
# Wait for checks (GitHub needs a moment after push)
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

**On failure**: Get the failed run logs to understand what broke:

```bash
# Find the failed run
RUN_ID=$(gh run list --branch "$BRANCH_NAME" --status failure --json databaseId --jq '.[0].databaseId')

# Get failed job logs
gh run view "$RUN_ID" --log-failed
```

Read the logs, fix the issue, commit atomically, push, and re-enter the loop.

### Gate B: review-work

The review-work skill launches 5 parallel sub-agents (goal verification, QA, code quality, security, context mining). All 5 must pass.

Invoke review-work after CI passes — there's no point reviewing code that doesn't build:

```
task(
  category="unspecified-high",
  load_skills=["review-work"],
  run_in_background=false,
  description="Post-implementation review of PR changes",
  prompt="Review the implementation work on branch {BRANCH_NAME}. The worktree is at {WORKTREE_PATH}. Goal: {ORIGINAL_GOAL}. Constraints: {CONSTRAINTS}."
)
```

**On failure**: review-work reports blocking issues with specific files and line numbers. Fix each blocking issue, commit, push, and re-enter the loop from Gate A (since code changed, CI must re-run).

### Iteration discipline

Each iteration through the loop:
1. Fix ONLY the issues identified by the failing gate
2. Commit atomically (one logical fix per commit)
3. Push
4. Re-enter from Gate A (code changed → full re-verification)

Avoid the temptation to "improve" unrelated code during fix iterations. Scope creep in the fix loop makes debugging harder and can introduce new failures.

</verify_loop>

---

## Phase 4: Merge & Cleanup

Once all gates pass:

<merge_cleanup>

### Merge the PR

```bash
# Squash merge to keep history clean
gh pr merge "$PR_NUMBER" --squash --delete-branch
```

### Sync .sisyphus state back to main repo

Before removing the worktree, copy `.sisyphus/` state back. When `.sisyphus/` is gitignored, files written there during worktree execution are not committed or merged — they would be lost on worktree removal.

```bash
if [ -d "$WORKTREE_PATH/.sisyphus" ]; then
  mkdir -p "$ORIGINAL_DIR/.sisyphus"
  cp -r "$WORKTREE_PATH/.sisyphus/"* "$ORIGINAL_DIR/.sisyphus/" 2>/dev/null || true
fi
```

### Clean up the worktree

```bash
cd "$ORIGINAL_DIR"
git worktree remove "$WORKTREE_PATH"
git worktree prune
```

### Report completion

```
## PR Merged ✅

- **PR**: #{PR_NUMBER} — {PR_TITLE}
- **Branch**: {BRANCH_NAME} → {BASE_BRANCH}
- **Iterations**: {N} verification loops
- **Gates passed**: CI ✅ | review-work ✅
- **Worktree**: cleaned up
```

</merge_cleanup>

---

## Failure Recovery

<failure_recovery>

If you hit an unrecoverable error (e.g., merge conflict with base branch, infrastructure failure):

1. **Do NOT delete the worktree** — the user may want to inspect or continue manually
2. Report what happened, what was attempted, and where things stand
3. Include the worktree path so the user can resume

For merge conflicts:

```bash
cd "$WORKTREE_PATH"
git fetch origin "$BASE_BRANCH"
git rebase "origin/$BASE_BRANCH"
# Resolve conflicts, then continue the loop
```

</failure_recovery>

---

## Anti-Patterns

| Violation | Why it fails | Severity |
|-----------|-------------|----------|
| Working in main worktree instead of isolated worktree | Pollutes user's working directory, may destroy uncommitted work | CRITICAL |
| Pushing directly to main/dev/master | Bypasses review entirely | CRITICAL |
| Skipping CI gate after code changes | review-work may pass on stale code | CRITICAL |
| Fixing unrelated code during verification loop | Scope creep causes new failures | HIGH |
| Deleting worktree on failure | User loses ability to inspect/resume | HIGH |
| Giant single commits | Harder to isolate failures, violates git-master principles | MEDIUM |
| Not running local checks before push | Wastes CI time on obvious failures | MEDIUM |
