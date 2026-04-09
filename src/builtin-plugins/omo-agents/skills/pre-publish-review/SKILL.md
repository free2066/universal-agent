---
name: pre-publish-review
description: "Nuclear-grade 16-agent pre-publish release gate. Detects all changes since last published version, spawns up to 10 parallel agents for deep per-change analysis, invokes review-work (5 agents) for holistic review, and 1 oracle for overall release synthesis. Use before EVERY npm/package publish. Triggers: 'pre-publish review', 'review before publish', 'release review', 'pre-release review', 'ready to publish?', 'can I publish?', 'pre-publish', 'safe to publish', 'publishing review', 'pre-publish check'."
---

# Pre-Publish Review — 16-Agent Release Gate

Three-layer review before publishing. Every layer covers a different angle — together they catch what any single review would miss.

```
Layer 1: Up to 10 Ultrabrain agents   → per-change deep analysis (parallel)
Layer 2: review-work (5 agents)       → holistic code, QA, security, goals review
Layer 3: 1 Oracle                     → release synthesis, semver, changelog draft
```

---

## Phase 0: Detect Unpublished Changes

First, identify what is changing since the last published version:

```bash
# Get the last published version
PUBLISHED=$(cat package.json | jq -r .version 2>/dev/null || echo "unknown")
# If using npm, you can also check: npm view . version
LOCAL=$(cat package.json | jq -r .version)

# Get all commits since published tag
ALL_COMMITS=$(git log "v${PUBLISHED}..HEAD" --oneline 2>/dev/null || git log --oneline -30)
COMMIT_COUNT=$(echo "$ALL_COMMITS" | wc -l | tr -d ' ')

# Get diff stat
DIFF_STAT=$(git diff "v${PUBLISHED}..HEAD" --stat 2>/dev/null || git diff HEAD~${COMMIT_COUNT}..HEAD --stat)
FILE_COUNT=$(echo "$DIFF_STAT" | grep -c '|' || echo "unknown")

# Get full diff
FULL_DIFF=$(git diff "v${PUBLISHED}..HEAD" 2>/dev/null || git diff HEAD~${COMMIT_COUNT}..HEAD)

echo "Published: v${PUBLISHED}, Local: ${LOCAL}, Commits: ${COMMIT_COUNT}, Files: ${FILE_COUNT}"
```

If `PUBLISHED` equals `LOCAL` and no tag exists, this might be a first release — use full git history instead.

---

## Phase 1: Parse Changes into Groups

Group related files into logical change groups. Each group = one ultrabrain agent.

Group by:
- **Same directory** (e.g., all changes in `src/agents/`, `src/hooks/`, `src/commands/`)
- **Same feature** (e.g., all files for a new hook implementation)
- **Same type** (e.g., all config schema files, all test files for a feature)

**Maximum 10 groups** (= 10 ultrabrain agents). If there are more than 10 logical groupings, merge minor/related groups.

For each group capture:
- `GROUP_NAME`: descriptive name (e.g., "oracle-agent-enhancements", "hooks-error-recovery")
- `GROUP_FILES`: list of files in this group
- `GROUP_DIFF`: `git diff v${PUBLISHED}..HEAD -- ${files}`
- `GROUP_COMMITS`: commits that touched these files

---

## Phase 2: Spawn All Agents

Launch ALL agents in a single turn. Every agent uses `run_in_background=true`. No sequential launches.

### Layer 1: Per-Change Analysis (up to 10 ultrabrain agents)

For EACH change group, spawn one agent:

```
task(
  category="unspecified-high",
  run_in_background=true,
  load_skills=[],
  description="Pre-publish: analyze {GROUP_NAME}",
  prompt="""
<group_name>{GROUP_NAME}</group_name>

<commits>
{GROUP_COMMITS — commits that touched these files}
</commits>

<diff>
{GROUP_DIFF — only the diff for this group files}
</diff>

<file_contents>
{Read and include full content of each changed file in this group}
</file_contents>

You are reviewing a specific subset of changes heading into a release. Focus exclusively on THIS change group. Other groups are reviewed by parallel agents.

ANALYSIS CHECKLIST:

1. **Intent Clarity**: What is this change trying to do? Is the intent clear from code and commits? If you have to guess, that's a finding.

2. **Correctness**: Trace through the logic for 3+ scenarios. Does the code actually do what it claims? Off-by-one errors, null handling, async edge cases, resource cleanup.

3. **Breaking Changes**: Does this change alter any public API, config format, CLI behavior, or hook contract? If yes, is it backward compatible? Would existing users be surprised?

4. **Pattern Adherence**: Does the new code follow the established patterns visible in the existing file contents? New patterns where old ones exist = finding.

5. **Edge Cases**: What inputs or conditions would break this? Empty arrays, undefined values, concurrent calls, very large inputs, missing config fields.

6. **Error Handling**: Are errors properly caught and propagated? No empty catch blocks? No swallowed promises?

7. **Type Safety**: Any `as any`, `@ts-ignore`, `@ts-expect-error`? Loose typing where strict is possible?

8. **Test Coverage**: Are the behavioral changes covered by tests? Are the tests meaningful or just coverage padding?

9. **Side Effects**: Could this change break something in a different module? Check imports and exports — who depends on what changed?

10. **Release Risk**: On a scale of SAFE / CAUTION / RISKY — how confident are you this change won't cause issues in production?

OUTPUT FORMAT:
<group_name>{GROUP_NAME}</group_name>
<verdict>PASS or FAIL</verdict>
<risk>SAFE / CAUTION / RISKY</risk>
<summary>2-3 sentence assessment of this change group</summary>
<has_breaking_changes>YES or NO</has_breaking_changes>
<breaking_change_details>If YES, describe what breaks and for whom</breaking_change_details>
<findings>
  For each finding:
  - [CRITICAL/MAJOR/MINOR] Category: Description
  - File: path (line range)
  - Evidence: specific code reference
  - Suggestion: how to fix
</findings>
<blocking_issues>Issues that MUST be fixed before publish. Empty if PASS.</blocking_issues>
"""
)
```

### Layer 2: Holistic Review via review-work (5 agents)

Spawn one coordinator that loads the `review-work` skill. The review-work skill internally launches 5 parallel agents.

```
task(
  category="unspecified-high",
  run_in_background=true,
  load_skills=["review-work"],
  description="Run review-work on all unpublished changes",
  prompt="""
Run review-work on the unpublished changes.

GOAL: Review all changes heading into the next release publish. These changes span {COMMIT_COUNT} commits across {FILE_COUNT} files.

CONSTRAINTS:
- This is a package published to npm — public API stability matters
- Do NOT introduce breaking changes without migration guides
- All tests must pass

BACKGROUND: Pre-publish review of the project. Changes since v{PUBLISHED} are about to be published.

The diff base is: git diff v{PUBLISHED}..HEAD

Follow the review-work skill flow exactly — launch all 5 review agents and collect results.
"""
)
```

### Layer 3: Oracle Release Synthesis (1 agent)

The oracle gets the full picture — all commits, full diff stat, and changed file list.

```
task(
  subagent_type="oracle",
  run_in_background=true,
  load_skills=[],
  description="Oracle: release synthesis and version bump recommendation",
  prompt="""
<review_type>RELEASE SYNTHESIS — OVERALL ASSESSMENT</review_type>

<published_version>{PUBLISHED}</published_version>
<local_version>{LOCAL}</local_version>

<all_commits>
{ALL_COMMITS since published version — hash, message, author, date}
</all_commits>

<diff_stat>
{DIFF_STAT — files changed, insertions, deletions}
</diff_stat>

<changed_files>
{CHANGED_FILES — full list of modified file paths}
</changed_files>

<full_diff>
{FULL_DIFF — the complete git diff between published version and HEAD}
</full_diff>

<file_contents>
{Read and include full content of KEY changed files — focus on public API surfaces, config schemas, agent definitions, hook registrations, tool registrations}
</file_contents>

You are the final gate before a release publish. Per-change agents are reviewing individual changes and 5 review-work agents are doing holistic review. Your job is the bird's-eye view that focused reviews might miss.

SYNTHESIS CHECKLIST:

1. **Release Coherence**: Do these changes tell a coherent story? Or is this a grab-bag of unrelated changes that should be split into multiple releases?

2. **Version Bump**: Based on semver:
   - PATCH: Bug fixes only, no behavior changes
   - MINOR: New features, backward-compatible changes
   - MAJOR: Breaking changes to public API, config format, or behavior
   Recommend the correct bump with specific justification.

3. **Breaking Changes Audit**: Exhaustively list every change that could break existing users. Check:
   - Config schema changes (new required fields, removed fields, renamed fields)
   - Agent behavior changes (different prompts, different model routing)
   - Hook contract changes (new parameters, removed hooks, renamed hooks)
   - Tool interface changes (new required params, different return types)
   - CLI changes (new commands, changed flags, different output)

4. **Migration Requirements**: If there are breaking changes, what migration steps do users need?

5. **Changelog Draft**: Write a draft changelog entry grouped by:
   - feat: New features
   - fix: Bug fixes
   - refactor: Internal changes (no user impact)
   - breaking: Breaking changes with migration instructions
   - docs: Documentation changes

6. **Deployment Risk Assessment**: SAFE / CAUTION / RISKY / BLOCK

7. **Post-Publish Monitoring**: What should be monitored after publish?

OUTPUT FORMAT:
<verdict>SAFE / CAUTION / RISKY / BLOCK</verdict>
<recommended_version_bump>PATCH / MINOR / MAJOR</recommended_version_bump>
<version_bump_justification>Why this bump level</version_bump_justification>
<release_coherence>Assessment of whether changes belong in one release</release_coherence>
<breaking_changes>
  Exhaustive list, or "None" if none.
  For each: What changed, Who is affected, Migration steps
</breaking_changes>
<changelog_draft>
  Ready-to-use changelog entry
</changelog_draft>
<deployment_risk>
  Overall risk assessment with specific concerns
</deployment_risk>
<monitoring_recommendations>
  What to watch after publish
</monitoring_recommendations>
<blocking_issues>Issues that MUST be fixed before publish. Empty if SAFE.</blocking_issues>
"""
)
```

---

## Phase 3: Collect Results

As agents complete, collect via `background_output(task_id="...")`.

Track completion in a table:

| # | Agent | Type | Status | Verdict |
|---|-------|------|--------|---------|
| 1-10 | {group_name} | unspecified-high | pending | — |
| 11 | Review-Work | unspecified-high | pending | — |
| 12 | Oracle Synthesis | oracle | pending | — |

**Do NOT deliver the final report until ALL agents have completed.**

---

## Phase 4: Final Verdict

**BLOCK** if:
- Oracle verdict is BLOCK
- Any per-change agent found CRITICAL blocking issues
- review-work failed on any of its 5 agents

**RISKY** if:
- Oracle verdict is RISKY
- Multiple per-change agents returned CAUTION or FAIL
- review-work passed but with significant findings

**CAUTION** if:
- Oracle verdict is CAUTION
- A few agents flagged minor issues
- review-work passed cleanly

**SAFE** if:
- Oracle verdict is SAFE
- All per-change agents passed
- review-work passed

Compile the final report:

```markdown
# Pre-Publish Review

## Release: v{PUBLISHED} → v{LOCAL}
**Commits:** {COMMIT_COUNT} | **Files Changed:** {FILE_COUNT} | **Agents:** {AGENT_COUNT}

---

## Overall Verdict: SAFE / CAUTION / RISKY / BLOCK

## Recommended Version Bump: PATCH / MINOR / MAJOR
{Justification from Oracle}

---

## Per-Change Analysis

| # | Change Group | Verdict | Risk | Breaking? | Blocking Issues |
|---|-------------|---------|------|-----------|-----------------|
| 1 | {name} | PASS/FAIL | SAFE/CAUTION/RISKY | YES/NO | {count or "none"} |

### Blocking Issues from Per-Change Analysis
{Aggregated, deduplicated}

---

## Holistic Review (review-work)

| # | Review Area | Verdict |
|---|------------|---------|
| 1 | Goal Verification | PASS/FAIL |
| 2 | QA Execution | PASS/FAIL |
| 3 | Code Quality | PASS/FAIL |
| 4 | Security | PASS/FAIL |
| 5 | Context Mining | PASS/FAIL |

---

## Release Synthesis (Oracle)

### Breaking Changes
{From Oracle — exhaustive list or "None"}

### Changelog Draft
{From Oracle — ready to use}

### Deployment Risk
{From Oracle — specific concerns}

---

## All Blocking Issues (Prioritized)
{Deduplicated, merged from all three layers, ordered by severity}

## Recommendations
{If BLOCK/RISKY: exactly what to fix, in priority order}
{If CAUTION: suggestions worth considering before publish}
{If SAFE: non-blocking improvements for future}
```

---

## Anti-Patterns

| Violation | Severity |
|-----------|----------|
| Publishing without waiting for all agents | **CRITICAL** |
| Spawning agents sequentially instead of all in parallel | CRITICAL |
| Using `run_in_background=false` for any agent | CRITICAL |
| Skipping the Oracle synthesis | HIGH |
| Not reading file contents for Oracle (it cannot read files on its own) | HIGH |
| Grouping all changes into 1-2 agents instead of distributing | HIGH |
| Delivering verdict before all agents complete | HIGH |
| Not including diff in per-change agent prompts | MAJOR |
