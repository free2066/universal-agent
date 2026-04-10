---
description: "Remove AI-generated code slop from recent changes. Checks diff and removes extra comments, defensive checks, type casts, and style inconsistencies."
argument-hint: "[branch to diff against, default: current uncommitted changes]"
---

Check the diff against the current branch's uncommitted changes (or compare with `$ARGUMENTS` if a branch name is provided), and remove all AI-generated slop introduced in those changes.

This includes:

- Extra comments that a human wouldn't add or that restate what the code obviously does
- Comments inconsistent with the rest of the file's comment style
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted or already-validated codepaths)
- Casts to `any` to get around type issues — find the correct type instead
- Style that is inconsistent with the surrounding file (naming, formatting, structure)
- Unnecessary emoji usage in code or comments
- Over-engineered abstractions that add complexity without value (unnecessary wrapper functions, pointless interfaces)
- Overly verbose error messages that repeat information already in the stack trace
- Redundant TypeScript type annotations that the compiler can already infer

## Rules

- Report only what you actually changed — a 1-3 sentence summary at the end
- Never refactor working logic while removing slop
- Never change behavior, only remove noise
- Keep all test files intact
- When in doubt whether something is slop, leave it — false positives are worse than false negatives

## Current diff

!`git diff HEAD 2>/dev/null || git diff 2>/dev/null`
