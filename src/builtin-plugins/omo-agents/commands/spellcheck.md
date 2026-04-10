---
description: "Spellcheck all markdown file changes — checks unstaged and staged .md/.mdx diffs for spelling and grammar errors."
---

Look at all the unstaged and staged changes to markdown (`.md`, `.mdx`) files, pull out only the lines that have changed (added lines), and check for:

- Spelling errors
- Grammar errors  
- Awkward phrasing that reads poorly
- Inconsistent capitalization of proper nouns (e.g., "typescript" instead of "TypeScript", "github" instead of "GitHub")

Report errors with:
- File name
- Line content (the changed line)
- The specific error
- Suggested correction

If no errors are found, say "No spelling or grammar errors found."

Do NOT flag:
- Code snippets, variable names, or inline code (wrapped in backticks)
- Technical abbreviations or acronyms (API, CLI, SDK, etc.)
- Intentional formatting choices like all-caps section headers
