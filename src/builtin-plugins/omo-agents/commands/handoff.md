---
description: "Generate a session handoff document to continue work in a new session. Captures current state, completed work, pending tasks, key decisions, and blockers. Saves to .sisyphus/handoff-{timestamp}.md."
---

Generate a session handoff document for: $ARGUMENTS

You are Sisyphus. Create a comprehensive handoff document so work can resume seamlessly in a new session.

## Your Mission

Read the current state of work and generate `.sisyphus/handoff-{YYYY-MM-DD}.md` — a document that gives the next session everything it needs to continue without re-discovering context.

## Information to Gather (Run in Parallel)

**Gather simultaneously:**
1. Read `.sisyphus/plans/*.md` — what was the plan? what's checked off?
2. Read `.sisyphus/notepads/` (if exists) — what was discovered during execution?
3. Run `git status` and `git log --oneline -20` — what was changed in this session?
4. Read current todo list — what's pending vs. completed?
5. Read `.sisyphus/context.md` (if exists) — project context reference

## Output Format

Save to `.sisyphus/handoff-{date}.md`:

```markdown
# Session Handoff — {date}

## Session Summary
{2–3 sentences: what was worked on, what was accomplished}

## Completed Work
{List of completed tasks, with brief description of what was done}
- ✅ {Task}: {what was implemented/fixed}
- ✅ {Task}: {what was implemented/fixed}

## Current State
{Description of where things stand right now}

## Pending Work
{List of remaining tasks, in priority order}
- 🔲 {Task}: {what needs to happen} — {why / any context}
- 🔲 {Task}: {what needs to happen} — {why / any context}

## Blockers
{Any issues blocking progress}
- 🔴 {Blocker}: {description, what's needed to unblock}

## Key Decisions Made
{Architectural or implementation decisions made during this session}
- **{Decision}**: {what was decided and why}

## Key Discoveries
{Important things learned about the codebase or problem}
- {Discovery}: {what was found, why it matters}

## Files Changed This Session
{List of files modified, with brief description}
- `{path}`: {what changed}

## How to Resume
1. {First step to take}
2. {Second step to take}

If using Atlas: plan file is at `.sisyphus/plans/{name}.md`. Use `/start-work` to resume execution.
If continuing manually: start with {specific task}.

## Context References
- Plan: `.sisyphus/plans/{name}.md`
- Notepads: `.sisyphus/notepads/{name}/`
- Context: `.sisyphus/context.md`
```

After creating the file, tell the user: "Handoff document saved to `.sisyphus/handoff-{date}.md`. Share this with your next session to resume work seamlessly."
