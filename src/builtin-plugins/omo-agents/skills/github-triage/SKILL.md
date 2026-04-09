---
name: github-triage
description: "Read-only GitHub triage for issues AND PRs. 1 item = 1 background task (category: quick). Analyzes all open items and writes evidence-backed reports to /tmp/{datetime}/. Every claim requires a GitHub permalink as proof. NEVER takes any action on GitHub - no comments, no merges, no closes, no labels. Reports only. Triggers: 'triage', 'triage issues', 'triage PRs', 'github triage'."
---

# GitHub Triage — Read-Only Analyzer

<role>
Read-only GitHub triage orchestrator. Fetch open issues/PRs, classify, spawn 1 background `quick` subagent per item. Each subagent analyzes and writes a report file. ZERO GitHub mutations.
</role>

## Architecture

**1 ISSUE/PR = 1 background task = 1 `quick` subagent. NO EXCEPTIONS.**

| Rule | Value |
|------|-------|
| Category | `quick` |
| Execution | `run_in_background=true` |
| Parallelism | ALL items simultaneously |
| Output | `/tmp/{YYYYMMDD-HHmmss}/issue-{N}.md` or `pr-{N}.md` |

---

## Zero-Action Policy (ABSOLUTE)

<zero_action>
Subagents MUST NEVER run ANY command that writes or mutates GitHub state.

**FORBIDDEN** (non-exhaustive):
`gh issue comment`, `gh issue close`, `gh issue edit`, `gh pr comment`, `gh pr merge`, `gh pr review`, `gh pr edit`, `gh api -X POST`, `gh api -X PUT`, `gh api -X PATCH`, `gh api -X DELETE`

**ALLOWED**:
- `gh issue view`, `gh pr view`, `gh api` (GET only) — read GitHub data
- `Grep`, `Read`, `Glob` — read codebase
- `Write` — write report files to `/tmp/` ONLY
- `git log`, `git show`, `git blame` — read git history (for finding fix commits)

**ANY GitHub mutation = CRITICAL violation.**
</zero_action>

---

## Evidence Rule (MANDATORY)

<evidence>
**Every factual claim in a report MUST include a GitHub permalink as proof.**

A permalink is a URL pointing to a specific line/range in a specific commit:
`https://github.com/{owner}/{repo}/blob/{commit_sha}/{path}#L{start}-L{end}`

### How to generate permalinks

1. Find the relevant file and line(s) via Grep/Read.
2. Get the current commit SHA: `git rev-parse HEAD`
3. Construct: `https://github.com/{REPO}/blob/{SHA}/{filepath}#L{line}`

### Rules

- **No permalink = no claim.** If you cannot back a statement with a permalink, state "No evidence found" instead.
- Claims without permalinks are explicitly marked `[UNVERIFIED]` and carry zero weight.
- Permalinks to `main`/`master`/`dev` branches are NOT acceptable — use commit SHAs only.
- For bug analysis: permalink to the problematic code. For fix verification: permalink to the fixing commit diff.
</evidence>

---

## Phase 0: Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPORT_DIR="/tmp/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REPORT_DIR"
COMMIT_SHA=$(git rev-parse HEAD)
```

Pass `REPO`, `REPORT_DIR`, and `COMMIT_SHA` to every subagent.

---

## Phase 1: Fetch All Open Items

**IMPORTANT:** `body` and `comments` fields may contain control characters that break jq parsing. Fetch basic metadata first, then fetch full details per-item in subagents.

```bash
# Step 1: Fetch basic metadata (without body/comments)
ISSUES_LIST=$(gh issue list --repo $REPO --state open --limit 500 \
  --json number,title,labels,author,createdAt)
ISSUE_COUNT=$(echo "$ISSUES_LIST" | jq length)

# Paginate if needed
if [ "$ISSUE_COUNT" -eq 500 ]; then
  LAST_DATE=$(echo "$ISSUES_LIST" | jq -r '.[-1].createdAt')
  while true; do
    PAGE=$(gh issue list --repo $REPO --state open --limit 500 \
      --search "created:<$LAST_DATE" \
      --json number,title,labels,author,createdAt)
    PAGE_COUNT=$(echo "$PAGE" | jq length)
    [ "$PAGE_COUNT" -eq 0 ] && break
    ISSUES_LIST=$(echo "$ISSUES_LIST" "$PAGE" | jq -s '.[0] + .[1] | unique_by(.number)')
    ISSUE_COUNT=$(echo "$ISSUES_LIST" | jq length)
    [ "$PAGE_COUNT" -lt 500 ] && break
    LAST_DATE=$(echo "$PAGE" | jq -r '.[-1].createdAt')
  done
fi

# Same for PRs
PRS_LIST=$(gh pr list --repo $REPO --state open --limit 500 \
  --json number,title,labels,author,headRefName,baseRefName,isDraft,createdAt)
PR_COUNT=$(echo "$PRS_LIST" | jq length)

echo "Total issues: $ISSUE_COUNT, Total PRs: $PR_COUNT"
```

**LARGE REPOSITORY HANDLING:**
If total items exceeds 50, you MUST process ALL items using the pagination code above.
**DO NOT** sample or limit — process the entire backlog.

---

## Phase 2: Classify

| Type | Detection |
|------|-----------|
| `ISSUE_QUESTION` | `[Question]`, `[Discussion]`, `?`, "how to" / "why does" / "is it possible" |
| `ISSUE_BUG` | `[Bug]`, `Bug:`, error messages, stack traces, unexpected behavior |
| `ISSUE_FEATURE` | `[Feature]`, `[RFE]`, `[Enhancement]`, `Feature Request`, `Proposal` |
| `ISSUE_OTHER` | Anything else |
| `PR_BUGFIX` | Title starts with `fix`, branch contains `fix/`/`bugfix/`, label `bug` |
| `PR_OTHER` | Everything else |

---

## Phase 3: Spawn Subagents (Individual Tool Calls)

**CRITICAL: Spawn tasks ONE BY ONE using individual tool calls. NEVER batch multiple items.**

For each item:

```
task(
  category="quick",
  run_in_background=true,
  load_skills=[],
  prompt=SUBAGENT_PROMPT
)
```

**ABSOLUTE RULES for Subagents:**
- **ONLY ANALYZE** — Never take action on GitHub (no comments, merges, closes)
- **READ-ONLY** — Use tools only for reading code/GitHub data
- **WRITE REPORT ONLY** — Output goes to `{REPORT_DIR}/{issue|pr}-{number}.md` via Write tool
- **EVIDENCE REQUIRED** — Every claim must have GitHub permalink as proof

---

## Subagent Prompts

### Common Preamble (include in ALL subagent prompts)

```
CONTEXT:
- Repository: {REPO}
- Report directory: {REPORT_DIR}
- Current commit SHA: {COMMIT_SHA}

PERMALINK FORMAT:
Every factual claim MUST include a permalink: https://github.com/{REPO}/blob/{COMMIT_SHA}/{filepath}#L{start}-L{end}
No permalink = no claim. Mark unverifiable claims as [UNVERIFIED].

ABSOLUTE RULES (violating ANY = critical failure):
- NEVER run gh issue comment, gh issue close, gh issue edit
- NEVER run gh pr comment, gh pr merge, gh pr review, gh pr edit
- NEVER run any gh command with -X POST, -X PUT, -X PATCH, -X DELETE
- Your ONLY writable output: {REPORT_DIR}/{issue|pr}-{number}.md via the Write tool
```

---

### ISSUE_QUESTION

```
You are analyzing issue #{number} for {REPO}.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: [fetch with: gh issue view {number} --repo {REPO} --json body -q .body]

TASK:
1. Understand the question.
2. Search the codebase (Grep, Read) for the answer.
3. For every finding, construct a permalink.
4. Write report to {REPORT_DIR}/issue-{number}.md

REPORT FORMAT:

# Issue #{number}: {title}
**Type:** Question | **Author:** {author} | **Created:** {createdAt}

## Question
[1-2 sentence summary]

## Findings
[Each finding with permalink. No permalink = mark [UNVERIFIED]]

## Suggested Answer
[Draft answer with code references and permalinks]

## Confidence: [HIGH | MEDIUM | LOW]
[Reason. If LOW: what's missing]

## Recommended Action
[What maintainer should do]
```

---

### ISSUE_BUG

```
You are analyzing bug report #{number} for {REPO}.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: [fetch with: gh issue view {number} --repo {REPO} --json body -q .body]

TASK:
1. Understand: expected behavior, actual behavior, reproduction steps.
2. Search the codebase for relevant code. Trace the logic.
3. Determine verdict: CONFIRMED_BUG, NOT_A_BUG, ALREADY_FIXED, or UNCLEAR.
4. For ALREADY_FIXED: find the fixing commit using git log/git blame.
5. For every finding, construct a permalink.
6. Write report to {REPORT_DIR}/issue-{number}.md

REPORT FORMAT:

# Issue #{number}: {title}
**Type:** Bug Report | **Author:** {author} | **Created:** {createdAt}

## Bug Summary
**Expected:** [what user expects]
**Actual:** [what actually happens]

## Verdict: [CONFIRMED_BUG | NOT_A_BUG | ALREADY_FIXED | UNCLEAR]

## Analysis

### Evidence
[Each piece of evidence with permalink. No permalink = mark [UNVERIFIED]]

### Root Cause (if CONFIRMED_BUG)
- Problematic code: [path#L{N}](permalink)

### Fix Details (if ALREADY_FIXED)
- **Fixed in commit:** [short_sha](https://github.com/{REPO}/commit/{full_sha})
- **What changed:** [description]

## Severity: [LOW | MEDIUM | HIGH | CRITICAL]

## Suggested Fix (if CONFIRMED_BUG)
[Specific approach: "In {file}#L{N}, change X to Y because Z"]

## Recommended Action
[What maintainer should do]
```

---

### ISSUE_FEATURE

```
You are analyzing feature request #{number} for {REPO}.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: [fetch with: gh issue view {number} --repo {REPO} --json body -q .body]

TASK:
1. Understand the request.
2. Search codebase for existing (partial/full) implementations.
3. Assess feasibility.
4. Write report to {REPORT_DIR}/issue-{number}.md

REPORT FORMAT:

# Issue #{number}: {title}
**Type:** Feature Request | **Author:** {author} | **Created:** {createdAt}

## Request Summary
[What the user wants]

## Existing Implementation: [YES_FULLY | YES_PARTIALLY | NO]
[If exists: where, with permalinks]

## Feasibility: [EASY | MODERATE | HARD | ARCHITECTURAL_CHANGE]

## Relevant Files
[With permalinks]

## Implementation Notes
[Approach, pitfalls, dependencies]

## Recommended Action
[What maintainer should do]
```

---

### PR_BUGFIX

```
You are reviewing PR #{number} for {REPO}.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}

TASK:
1. Fetch PR details (READ-ONLY): gh pr view {number} --repo {REPO} --json files,reviews,statusCheckRollup,reviewDecision
2. Read diff: gh api repos/{REPO}/pulls/{number}/files
3. Search codebase to verify fix correctness.
4. Write report to {REPORT_DIR}/pr-{number}.md

REPORT FORMAT:

# PR #{number}: {title}
**Type:** Bugfix | **Author:** {author}

## Fix Summary
[What bug, how fixed — with permalinks to changed code]

## Code Review

### Correctness
[Is fix correct? Root cause addressed? Evidence with permalinks]

### Side Effects
[Risky changes, breaking changes]

## Merge Readiness

| Check | Status |
|-------|--------|
| CI | [PASS / FAIL / PENDING] |
| Review | [APPROVED / CHANGES_REQUESTED / PENDING / NONE] |
| Mergeable | [YES / NO / CONFLICTED] |
| Draft | [YES / NO] |
| Risk | [NONE / LOW / MEDIUM / HIGH] |

## Recommended Action: [MERGE | REQUEST_CHANGES | NEEDS_REVIEW | WAIT]

---
NEVER merge. NEVER comment. NEVER review. Write to file ONLY.
```

---

### PR_OTHER

```
You are reviewing PR #{number} for {REPO}.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}

TASK:
1. Fetch PR details (READ-ONLY): gh pr view {number} --repo {REPO} --json files,reviews,statusCheckRollup,reviewDecision
2. Read diff: gh api repos/{REPO}/pulls/{number}/files
3. Write report to {REPORT_DIR}/pr-{number}.md

REPORT FORMAT:

# PR #{number}: {title}
**Type:** [FEATURE | REFACTOR | DOCS | CHORE | TEST | OTHER]
**Author:** {author}

## Summary
[2-3 sentences with permalinks to key changes]

## Status

| Check | Status |
|-------|--------|
| CI | [PASS / FAIL / PENDING] |
| Review | [APPROVED / CHANGES_REQUESTED / PENDING / NONE] |
| Mergeable | [YES / NO / CONFLICTED] |
| Risk | [LOW / MEDIUM / HIGH] |

## Files Changed
[Count and key files]

## Blockers
[If any]

## Recommended Action: [MERGE | REQUEST_CHANGES | NEEDS_REVIEW | CLOSE | WAIT]

---
NEVER merge. NEVER comment. NEVER review. Write to file ONLY.
```

---

## Phase 4: Final Summary

After all subagents complete, write to `{REPORT_DIR}/SUMMARY.md` AND display to user:

```markdown
# GitHub Triage Report — {REPO}

**Date:** {date} | **Commit:** {COMMIT_SHA}
**Items Processed:** {total}
**Report Directory:** {REPORT_DIR}

## Issues ({issue_count})
| Category | Count |
|----------|-------|
| Bug Confirmed | {n} |
| Bug Already Fixed | {n} |
| Not A Bug | {n} |
| Needs Investigation | {n} |
| Question Analyzed | {n} |
| Feature Assessed | {n} |
| Other | {n} |

## PRs ({pr_count})
| Category | Count |
|----------|-------|
| Bugfix Reviewed | {n} |
| Other PR Reviewed | {n} |

## Items Requiring Attention
[Each item: number, title, verdict, 1-line summary, link to report file]

## Report Files
[All generated files with paths]
```

---

## Anti-Patterns

| Violation | Severity |
|-----------|----------|
| ANY GitHub mutation (comment/close/merge/review/label/edit) | **CRITICAL** |
| Claim without permalink | **CRITICAL** |
| Batching multiple items into one task | CRITICAL |
| `run_in_background=false` | CRITICAL |
| Guessing without codebase evidence | HIGH |
| Not writing report to `{REPORT_DIR}` | HIGH |
| Using branch name instead of commit SHA in permalink | HIGH |
