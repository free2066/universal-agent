---
description: "View and manage permission rules (allow/deny/ask) for tool calls"
argument-hint: "[list|add|remove|clear] [options]"
---

# Permission Rules Manager

You are managing the permission rule system for universal-agent.
The permission system controls which tool calls are automatically allowed, denied, or require user approval.

## Current Permission Rules

Show the current state using:
```
import { getPermissionService } from './src/services/permission/index.js'
const perm = getPermissionService()
const rules = perm.listRules()
```

## How Rules Work

Each rule has:
- **permission**: tool category (e.g. `bash`, `file:write`, `file:read`, `network`, `*` for all)
- **pattern**: glob pattern matched against the tool argument (uses minimatch)
- **action**: `allow` | `deny` | `ask`

Rules are checked in order; **first match wins**. Default (no match) = `ask`.

Priority: `deny` > `ask` > `allow`

## Common Examples

**Block dangerous bash commands:**
```json
{ "permission": "bash", "pattern": "rm -rf *", "action": "deny" }
{ "permission": "bash", "pattern": "sudo *", "action": "ask" }
```

**Auto-allow safe file reads:**
```json
{ "permission": "file:read", "pattern": "**/*.md", "action": "allow" }
```

**Block writes to sensitive paths:**
```json
{ "permission": "file:write", "pattern": "/etc/**", "action": "deny" }
{ "permission": "file:write", "pattern": "~/.ssh/**", "action": "deny" }
```

## Task

Based on the user's request, help them:
1. **List** current rules: Show all rules in a readable table
2. **Add** a rule: Create a new permission rule and persist it
3. **Remove** a rule: Remove a rule by id and save
4. **Clear** all rules: Remove all rules
5. **Evaluate** a permission: Test what action would be taken for a given tool/value

After any modification, call `perm.saveRules()` to persist.

The user's request: $ARGUMENTS
