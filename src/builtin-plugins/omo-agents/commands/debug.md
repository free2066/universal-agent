---
description: "Debug a specific error, bug, or unexpected behavior. Delegates to the debug agent which performs root cause analysis and applies a minimal fix. Provide the error message, file path, or description of the problem."
argument-hint: "<error message or description of the bug>"
agent: debug
---

Debug the following issue and find the root cause:

**$ARGUMENTS**

Perform a thorough root cause analysis:
1. Identify where the error originates
2. Trace the call path to the source
3. Determine the minimal fix
4. Apply the fix and verify it resolves the issue

If no specific error is provided, check recent changes in the codebase for common bug patterns, then report findings.
