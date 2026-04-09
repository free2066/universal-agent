---
description: "Detect and remove AI-generated code smells from the current branch's changes. Analyzes diffs for over-commenting, unnecessary abstractions, verbose error messages, and non-idiomatic patterns. Safe: proposes changes for review before applying."
argument-hint: "[branch or leave empty for current changes]"
---

Analyze the current branch's changes for AI-generated code smells and propose targeted cleanup.

## Step 1: Gather the Diff

```bash
git diff main..HEAD   # or use the provided branch argument
```

If no branch argument: analyze uncommitted changes with `git diff` and `git diff --staged`.

## Step 2: Delegate to Oracle for AI Smell Detection

Pass the full diff to `omo-agents:oracle` with this review prompt:

```
You are reviewing a code diff for AI-generated code smells — patterns that indicate the code was written by an AI assistant without human editorial judgment.

DIFF:
{FULL_DIFF}

Identify instances of these AI code smells:

**1. Over-commenting** — Comments that restate what the code obviously does:
   Bad:  `// Increment counter by 1`
   Good: `// Skip header row — index 0 is column labels`

**2. Unnecessary abstractions** — Wrapper functions, interfaces, or types that add no value:
   Bad:  `interface IUserRepository { getUser(id: string): Promise<User> }`
   Good: Just use the concrete class directly

**3. Verbose error messages** — Error messages with excessive explanation:
   Bad:  `throw new Error("The user ID parameter is required and cannot be null or undefined")`
   Good: `throw new Error("userId required")`

**4. Redundant type annotations** — Types already inferred by TypeScript:
   Bad:  `const count: number = 0`
   Good: `const count = 0`

**5. Defensive over-engineering** — Null checks and guards for things that can't be null in context

**6. Boilerplate prose in code** — Variable names like `result`, `data`, `response`, `temp`, `item`

**7. Hedge comments** — `// Note:`, `// Please note:`, `// Important:` followed by obvious statements

For each issue found, provide:
- File and line number
- The problematic code snippet
- The cleaned-up version
- Why this is an AI smell

If the diff is clean, say so. Do not invent issues.
```

## Step 3: Present Findings

Show Oracle's findings clearly:
- Group by file
- Show before/after for each proposed change
- Let user decide which to apply

## Step 4: Apply Approved Changes

For each approved change, use `hashline_edit` or `Edit` tool to apply it precisely.

After all changes:
```bash
git diff    # show final state
```

Confirm the changes look correct before finishing.

## Safety Rules

- **NEVER apply changes without showing them first** — always propose, then wait for approval
- **NEVER refactor logic** — only cosmetic/comment/naming changes
- **NEVER change behavior** — if a change might affect runtime behavior, skip it and flag it
- **Preserve all tests** — do not touch test files unless they contain the specific smell
