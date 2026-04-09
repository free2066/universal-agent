---
name: review-work
description: "5-agent parallel code review. Spawns: Goal Verifier (oracle), QA Executor, Code Reviewer (oracle), Security Auditor (oracle), Context Miner. All run in background simultaneously. Use after completing implementation to catch issues before merging."
---

# Review Work — 5-Agent Parallel Code Review

This skill orchestrates a comprehensive parallel review of completed implementation work. Five specialized agents run simultaneously, each examining a different dimension of quality.

---

## WHEN TO USE

Load this skill after completing implementation, before merging or declaring work done:
- After `/start-work` plan execution completes
- After a complex feature implementation
- Before creating a PR
- When asked to "review my work" or "check what I did"

---

## PHASE 0: PREPARE REVIEW CONTEXT

Before launching agents, gather the diff:

```bash
git diff HEAD~1..HEAD --stat          # what changed
git diff HEAD~1..HEAD                 # full diff
```

If reviewing uncommitted work:
```bash
git diff                              # unstaged
git diff --staged                     # staged
```

Collect:
1. **DIFF** — full `git diff` output
2. **CHANGED_FILES** — list of modified files with full content
3. **TASK_DESCRIPTION** — what was supposed to be built

---

## PHASE 1: LAUNCH ALL 5 AGENTS IN PARALLEL

Launch ALL five agents simultaneously with `run_in_background=true`:

### Agent 1: Goal Verifier (Oracle)

```
task(
  subagent_type="omo-agents:oracle",
  run_in_background=true,
  description="Goal verification review",
  prompt="""
TASK: Verify this implementation matches its stated goal.

DIFF:
{DIFF}

CHANGED FILES:
{FILE_CONTENTS}

TASK DESCRIPTION:
{TASK_DESCRIPTION}

REVIEW FOCUS: Goal alignment only.
1. Does the implementation actually accomplish what was asked?
2. Are there missing requirements or acceptance criteria not met?
3. Are there scope overruns (things implemented that weren't asked for)?

Return: PASS or FAIL with specific evidence. Be concise.
"""
)
```

### Agent 2: QA Executor

```
task(
  category="unspecified-high",
  run_in_background=true,
  description="QA and behavioral verification",
  prompt="""
TASK: Verify the implementation actually works.

CHANGED FILES (read and run these):
{CHANGED_FILE_PATHS}

1. Run the build: npm run build (or equivalent)
2. Run tests: npm test (or equivalent)
3. If CLI: run the command with sample inputs
4. If API: check the endpoint responds correctly
5. Check LSP diagnostics on changed files

Report: what passed, what failed, exact error messages.
"""
)
```

### Agent 3: Code Reviewer (Oracle)

```
task(
  subagent_type="omo-agents:oracle",
  run_in_background=true,
  description="Code quality review",
  prompt="""
TASK: Review code quality of this implementation.

DIFF:
{DIFF}

CHANGED FILES:
{FILE_CONTENTS}

REVIEW FOCUS: Code quality only.
1. Logic errors or incorrect assumptions
2. Missing edge cases (null/undefined, empty arrays, concurrent access)
3. Stub implementations (TODO, throw new Error("not implemented"))
4. Patterns that don't match the existing codebase
5. Unnecessary complexity or over-engineering

Return: list of specific issues with file + line references. PASS if no issues.
"""
)
```

### Agent 4: Security Auditor (Oracle)

```
task(
  subagent_type="omo-agents:oracle",
  run_in_background=true,
  description="Security review",
  prompt="""
TASK: Security review of this implementation.

DIFF:
{DIFF}

CHANGED FILES:
{FILE_CONTENTS}

REVIEW FOCUS: Security only.
1. Input validation — is user input sanitized before use?
2. Authentication/authorization — are endpoints/operations properly gated?
3. Secrets — any hardcoded credentials, API keys, or tokens?
4. Injection risks — SQL, command, path traversal
5. Data exposure — sensitive data in logs, responses, or error messages

Return: list of specific security concerns with severity (HIGH/MED/LOW). PASS if clean.
"""
)
```

### Agent 5: Context Miner

```
task(
  category="unspecified-high",
  run_in_background=true,
  description="Context and coverage check",
  prompt="""
TASK: Find what was missed in this implementation.

CHANGED FILES:
{CHANGED_FILE_PATHS}

1. Search the codebase for other places that reference the changed symbols
2. Check if similar patterns elsewhere in the codebase weren't updated consistently
3. Find tests that should have been updated but weren't
4. Identify callers of changed functions that might break

Use grep_search and codebase_search to find related code.
Report: specific gaps or missed updates. PASS if nothing found.
"""
)
```

---

## PHASE 2: COLLECT AND SYNTHESIZE RESULTS

Wait for all 5 agents to complete, then collect:

```
results = {
  goal_verifier: background_output(task_id="..."),
  qa_executor: background_output(task_id="..."),
  code_reviewer: background_output(task_id="..."),
  security_auditor: background_output(task_id="..."),
  context_miner: background_output(task_id="...")
}
```

---

## PHASE 3: GENERATE REVIEW REPORT

Present findings in this format:

```markdown
## Review Report

### Summary
[PASS / FAIL / PASS WITH WARNINGS]

### Agent Results

| Dimension | Status | Issues |
|-----------|--------|--------|
| Goal Alignment | ✅/❌ | [count] |
| QA / Tests | ✅/❌ | [count] |
| Code Quality | ✅/❌ | [count] |
| Security | ✅/❌ | [count] |
| Coverage | ✅/❌ | [count] |

### Issues Found (if any)

**[SEVERITY] [Dimension]: [File:Line]**
[Description of issue]
[Suggested fix]

### Recommendation
[Overall assessment and recommended next steps]
```

---

## PASS CRITERIA

Work is READY TO MERGE when:
- Goal Verifier: PASS
- QA Executor: all tests pass, build succeeds
- Code Reviewer: no HIGH/CRITICAL issues
- Security Auditor: no HIGH/CRITICAL issues
- Context Miner: no missed callers or broken patterns

Any FAIL from any agent → fix before merging.
