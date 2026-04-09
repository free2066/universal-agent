---
description: Full npm publish workflow with pre-publish review gate, version bump, release notes, and verification. Requires explicit bump type argument.
argument-hint: "<patch|minor|major>"
---

<command-instruction>

You are the release manager. Execute the FULL publish workflow from start to finish.

## CRITICAL: ARGUMENT REQUIREMENT

**You MUST receive a version bump type from the user.** Valid options:
- `patch`: Bug fixes, backward-compatible (1.1.7 → 1.1.8)
- `minor`: New features, backward-compatible (1.1.7 → 1.2.0)
- `major`: Breaking changes (1.1.7 → 2.0.0)

**If the user did not provide a bump type argument, STOP IMMEDIATELY and ask:**
> "To proceed with publish, please specify a version bump type: `patch`, `minor`, or `major`"

**DO NOT PROCEED without explicit user confirmation of bump type.**

---

## STEP 0: REGISTER TODO LIST (MANDATORY FIRST ACTION)

**Before doing ANYTHING else**, create a todo list using TodoWrite:

```
[
  { "id": "pre-review", "content": "Run pre-publish-review gate (load skill: pre-publish-review)", "status": "pending" },
  { "id": "confirm-bump", "content": "Confirm version bump type with user (patch/minor/major)", "status": "pending" },
  { "id": "check-uncommitted", "content": "Check for uncommitted changes", "status": "pending" },
  { "id": "bump-version", "content": "Bump version in package.json", "status": "pending" },
  { "id": "build", "content": "Build the project", "status": "pending" },
  { "id": "commit-push", "content": "Commit and push version bump", "status": "pending" },
  { "id": "verify-npm", "content": "Verify npm publish and package availability", "status": "pending" },
  { "id": "final-confirmation", "content": "Final confirmation to user", "status": "pending" }
]
```

Mark each todo as `in_progress` when starting, `completed` when done.

---

## STEP 1: PRE-PUBLISH REVIEW GATE

**Before bumping any version**, run the pre-publish review:

```
Load skill: pre-publish-review
```

The skill will spawn multiple agents to review all unpublished changes. Do not proceed until the review completes with a SAFE or CAUTION verdict.

**If verdict is BLOCK or RISKY**: STOP. Report the blocking issues to the user and ask if they want to fix them first.

**If verdict is CAUTION**: Summarize the concerns and ask user to confirm they want to proceed.

**If verdict is SAFE or user confirms proceeding**: Continue to Step 2.

---

## STEP 2: CONFIRM BUMP TYPE

If bump type provided as argument, confirm with user:
> "Version bump type: `{bump}`. Proceed? (y/n)"

Wait for user confirmation before proceeding.

---

## STEP 3: CHECK UNCOMMITTED CHANGES

```bash
git status --porcelain
```

If there are uncommitted changes: warn user and ask if they want to commit first.

---

## STEP 4: BUMP VERSION

```bash
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const [a,b,c] = p.version.split('.').map(Number);
const newVersion = '{bump_type}' === 'major' ? (a+1)+'.0.0'
  : '{bump_type}' === 'minor' ? a+'.'+(b+1)+'.0'
  : a+'.'+b+'.'+(c+1);
p.version = newVersion;
fs.writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n');
console.log('Bumped to', newVersion);
"
```

Note the new version for subsequent steps.

---

## STEP 5: BUILD

```bash
bun run build 2>&1 | tail -5
```

If build fails: revert version bump (`git checkout package.json`) and report to user.

---

## STEP 6: PUBLISH TO NPM

```bash
npm publish
```

If publish fails due to auth: run `npm login` and ask user to authenticate.

---

## STEP 7: COMMIT AND TAG

```bash
git add package.json
git commit -m "chore: release v{NEW_VERSION}"
git tag "v{NEW_VERSION}"
git push && git push --tags
```

---

## STEP 8: DRAFT RELEASE NOTES (OPTIONAL)

For **minor** and **major** releases, draft release notes:

1. Get commits since last tag:
```bash
PREV_TAG=$(git describe --tags --abbrev=0 HEAD~1 2>/dev/null || echo "initial")
git log "${PREV_TAG}..HEAD~1" --oneline
```

2. Group by type (feat/fix/refactor/breaking)
3. Write user-impact narrative (what users can now DO, not just what changed)
4. Present draft to user for review

**Rules for release notes:**
- NEVER duplicate commit messages — write impact narrative instead
- NEVER write generic filler ("Various improvements", "Bug fixes")
- ALWAYS focus on user impact: "You can now do X" not "Added X feature"
- Group by THEME, not by commit type

---

## STEP 9: VERIFY NPM PUBLICATION

Poll npm registry until new version appears:
```bash
npm view . version
```

Compare with expected version. If not matching after 2 minutes, warn about npm propagation delay.

---

## STEP 10: FINAL CONFIRMATION

Report success to user with:
- New version number
- npm package: `npm install {package-name}@{NEW_VERSION}`
- Commits included in this release
- Any release notes drafted

---

## ERROR HANDLING

- **Build fails**: Revert version bump, fix the build, restart from Step 4
- **npm publish fails (auth)**: Run `npm login` and retry
- **npm publish fails (version exists)**: Version already published — check if this was intentional
- **Push fails**: Check remote configuration and authentication
- **Pre-publish review BLOCK**: Fix blocking issues before proceeding

## LANGUAGE

Respond in the same language as the user's request.

</command-instruction>

<current-context>
<local-version>
!`node -p "require('./package.json').version" 2>/dev/null || echo "unknown"`
</local-version>
<git-status>
!`git status --porcelain`
</git-status>
<recent-commits>
!`git log --oneline -10`
</recent-commits>
</current-context>

<user-request>
$ARGUMENTS
</user-request>
