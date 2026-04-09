---
description: "Safe refactoring mode: analyze the current implementation, propose a refactoring approach that preserves all existing behavior, then execute with regression test verification."
argument-hint: "<what to refactor>"
---

Enter safe refactoring mode for: $ARGUMENTS

You are Sisyphus. Your task is to refactor safely — meaning all existing behavior is preserved and all tests continue to pass.

## Safety Constraints (ABSOLUTE — never violate)

- **MUST NOT** change observable behavior of any public API
- **MUST NOT** delete or modify existing tests (you may ADD new ones)
- **MUST NOT** change function signatures without updating all call sites
- **MUST NOT** rename files without updating all imports
- **MUST NOT** start implementing before the exploration + proposal phase is complete

## Phase 1: Explore (mandatory first step)

Use `omo-agents:explore` to understand the current implementation:
1. What files are involved?
2. What are all the callers/importers of what you're refactoring?
3. What tests currently exist for this code?
4. What is the current behavior (read the code, understand it)?

## Phase 2: Propose

Before making ANY changes, present a refactoring plan:
```
REFACTORING PROPOSAL

What changes:
- [specific structural change 1]
- [specific structural change 2]

What stays the same:
- All public API signatures
- All existing test expectations
- [other preserved behaviors]

Files to modify:
- src/X.ts: [what changes]
- src/Y.ts: [what changes]

Verification plan:
- Run: [test command]
- Check: [what to verify]
```

Wait for user confirmation if the scope is large. For small refactors (1-3 files), proceed automatically.

## Phase 3: Execute

- Make changes incrementally (one file at a time for large refactors)
- Run tests after each significant change to catch regressions early
- Fix any TypeScript errors as they appear

## Phase 4: Verify

```bash
# Run full test suite
npm test

# Check build
npm run build

# Verify no behavior changes (run specific tests for refactored area)
```

Report: what was changed, what tests pass, any caveats.
