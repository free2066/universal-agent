---
description: "Run the test suite, identify failing tests, and fix them. Automatically runs tests, collects failure output, and delegates to hephaestus to fix the root cause. Use when tests are broken after a change."
argument-hint: "[optional: specific test file or test name pattern]"
allowed-tools: Bash, Read, Grep, Glob, LS, Edit, Write, MultiEdit, Agent
---

Run the test suite and fix any failing tests.

!`echo "Project root: $(pwd)" && ls package.json 2>/dev/null && (cat package.json | grep -E '"test"|"jest"|"vitest"' || echo "No test scripts found")`

## Instructions

1. **Detect the test runner**: Check `package.json` scripts for `test`, `jest`, `vitest`, or look for `pytest.ini`, `go.mod`
2. **Run the tests**: Execute the full test suite (or the specific test if `$ARGUMENTS` is provided)
3. **Collect failures**: Capture all failing tests, error messages, and stack traces
4. **Analyze root cause**: For each failure, identify why it's failing
5. **Fix the failures**: Apply the minimum changes needed to make tests pass

If `$ARGUMENTS` is specified, focus on that test file or test name pattern.

### Common test commands:
- `npm test` / `npx jest` / `npx vitest`
- `pytest` / `python -m pytest`
- `go test ./...`
- `cargo test`

After fixing, run tests again to confirm they pass.

### Output format:
```
## Test Run Summary

**Tests before fix**: [N passing, M failing]
**Failures fixed**: [list of test names]
**Root cause**: [brief explanation]
**Tests after fix**: [N passing, 0 failing]
```
