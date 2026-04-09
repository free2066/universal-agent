---
name: git-master
description: "MUST USE for ANY git operations. Atomic commits with correct granularity (3+ files = 2+ commits), rebase/squash workflow, history search (blame, bisect, log -S). Load this skill whenever doing commits, rebasing, or git archaeology."
---

# Git Master — Atomic Commits, Clean History

You are equipped with git-master. This skill governs ALL git operations in this session.

---

## OPERATION MODE DETECTION

Classify the request before acting:

| Request | Mode |
|---------|------|
| commit / push / save changes | **COMMIT** |
| rebase / squash / clean history / fixup | **REBASE** |
| find when X changed / who wrote Y / bisect | **HISTORY_SEARCH** |

---

## COMMIT MODE

### Phase 0: Analyze Change Scope

```bash
git diff --stat HEAD
git status --short
```

Count the number of files changed and their categories.

### Phase 1: Determine Commit Granularity (MANDATORY)

**Atomic commit rules — STRICTLY enforced:**

| Files changed | Minimum commits required |
|---------------|--------------------------|
| 1–2 files | 1 commit acceptable |
| 3–4 files | 2+ commits required |
| 5–9 files | 3+ commits required |
| 10+ files | 5+ commits required |

**Single commit handling multiple files = BUG. Split it.**

Split criteria (each of these = separate commit):
- Different directories/modules
- Different component types (types vs logic vs tests)
- Different concerns (feat vs fix vs refactor)
- Changes that can be independently reverted
- UI vs backend vs config changes

### Phase 2: Stage and Commit Each Group

For each logical group:

```bash
git add [specific files for this group]
git commit -m "[type]([scope]): [description]"
```

**Commit message format (Conventional Commits):**

```
type(scope): short description (≤72 chars)

[optional body — what and why, not how]

[optional footer — breaking changes, closes #issue]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`, `ci`

**Good commit messages:**
- `feat(auth): add JWT refresh token rotation`
- `fix(api): handle empty response body in error handler`
- `refactor(commands): extract duplicate dedup logic to shared util`

**Bad commit messages:**
- `fix stuff`
- `update files`
- `wip`
- `changes`

### Phase 3: Verify

```bash
git log --oneline -5   # confirm commits look right
git diff HEAD~N HEAD   # spot-check the diff
```

---

## REBASE MODE

### When to rebase vs merge

- **Rebase**: cleaning up local commits before push, squashing WIP commits
- **Merge**: incorporating remote changes, preserving public history
- **NEVER** rebase commits that have been pushed to a shared branch

### Interactive Rebase Workflow

```bash
git rebase -i HEAD~N   # N = number of commits to review
```

In the editor:
- `pick` — keep as-is
- `reword` — keep but edit message
- `squash` / `s` — combine into previous commit (keeps message)
- `fixup` / `f` — combine into previous commit (discard message)
- `drop` — delete commit

### Squash WIP commits

```bash
# Before push: clean up "wip", "fix typo", "asdf" commits
git rebase -i origin/main
# Mark WIP commits as fixup, keep the meaningful ones
```

### After rebase

```bash
git log --oneline   # verify history is clean
# If already pushed to personal branch:
git push --force-with-lease   # safer than --force
```

---

## HISTORY_SEARCH MODE

### Find when a specific string was added/removed

```bash
git log -S "exact string" --oneline
git log -S "function_name" --all --oneline
```

### Find who changed a specific line

```bash
git blame [file] -L [start],[end]
git blame -w [file]   # ignore whitespace changes
```

### Search commit messages

```bash
git log --grep="keyword" --oneline
git log --grep="JIRA-123" --all --oneline
```

### Find when a bug was introduced (bisect)

```bash
git bisect start
git bisect bad HEAD          # current is bad
git bisect good [known-good-commit]
# Git checks out middle commit — test it, then:
git bisect good   # or: git bisect bad
# Repeat until bisect finds the culprit
git bisect reset  # cleanup
```

### Trace a file's full history

```bash
git log --follow --oneline [file]
git log --follow -p [file]   # includes full diff
```

---

## GOLDEN RULES

1. **Commit early, commit often** — never leave work uncommitted overnight
2. **One logical change per commit** — reviewers should understand each commit in isolation
3. **Never commit broken code** — each commit should leave the repo in a working state
4. **Write for your future self** — commit messages are documentation
5. **`--force-with-lease` not `--force`** — protects against overwriting others' work
