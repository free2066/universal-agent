---
description: "Export the current session as a Markdown file for sharing or archiving. Generates a structured summary including session title, model, modified files, and key conversation highlights. Saves to .uagent-shares/<timestamp>.md"
argument-hint: "[optional: custom title for the share]"
allowed-tools: Bash, Read, Write
---

Export this session as a shareable Markdown document.

!`echo "Session export directory: $(pwd)/.uagent-shares" && git log --oneline -5 2>/dev/null || echo "Not a git repo"`

## Instructions

Create a session share document at `.uagent-shares/<timestamp>-<title>.md`:

1. **Determine the title**: Use `$ARGUMENTS` if provided, otherwise generate a concise title from the conversation context (3-6 words).

2. **Gather session information**:
   ```bash
   # Files modified in this session
   git diff --name-only HEAD 2>/dev/null || echo "(git not available)"
   
   # Recent git commits (if any)  
   git log --oneline -10 2>/dev/null || echo "(no commits)"
   
   # Current directory and timestamp
   echo "Directory: $(pwd)"
   echo "Date: $(date '+%Y-%m-%d %H:%M')"
   ```

3. **Generate the Markdown document** with this structure:

```markdown
# Session Share: <title>

**Date**: <YYYY-MM-DD HH:MM>  
**Model**: <model used>  
**Project**: <project name from package.json or directory name>

## Summary

<2-3 sentence summary of what was accomplished in this session>

## Files Modified

<list of files changed with brief description of each change>

## Key Changes

<bullet points of the most important changes made>

## How to Use

<brief instructions on how to use/test the changes, if applicable>
```

4. **Save the file**:
   ```bash
   mkdir -p .uagent-shares
   # Write the document to .uagent-shares/<timestamp>-<slug>.md
   ```

5. **Report the file path** so the user can find it easily.

After saving, display the full path and offer to copy the content to clipboard if on macOS (`pbcopy`).
