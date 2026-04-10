---
description: "Commit and push current changes with a meaningful commit message focused on WHY, not WHAT."
argument-hint: "[commit message hint or leave empty]"
---

Commit and push the current changes.

## Rules for the commit message

- Use one of these prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `wip:`
- For omo-agents or builtin-plugins changes, use the module name: `omo-agents:`, `plugins:`
- Explain **WHY** something was done from an end-user perspective, not WHAT was done
- Be specific — do not write generic messages like "improved agent experience" or "updated code"
- If there are multiple logical changes, use the most significant one as the subject; mention others in the body
- If there are merge conflicts, **DO NOT attempt to fix them** — notify the user immediately and stop

## Commit message format

```
<prefix>: <specific user-facing change and why>

[optional body with additional context]
```

## Examples of good messages

- `feat(omo-agents): add /learn command to persist session insights into AGENTS.md`
- `fix(AgentTool): expose task_id parameter so agents can resume prior sessions`
- `refactor(explore): replace disallowedTools blacklist with precise tools whitelist`

## Examples of bad messages

- `fix: updated stuff` ← too vague
- `feat: added new feature` ← no specifics
- `chore: various improvements` ← meaningless

## Current git state

**Git diff (staged + unstaged):**
!`git diff HEAD 2>/dev/null || git diff 2>/dev/null`

**Staged files:**
!`git diff --cached --name-only 2>/dev/null`

**Unstaged changes:**
!`git status --short 2>/dev/null`

---

Now stage all relevant changes, write the commit message, commit, and push.

If `$ARGUMENTS` is provided, use it as a hint for the commit message subject.
