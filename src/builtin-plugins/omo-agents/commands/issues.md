---
description: "Search GitHub issues in this repository matching a query. Uses the gh CLI to find existing issues."
argument-hint: "<search query>"
---

Search through existing GitHub issues in this repository using the `gh` CLI to find issues matching this query:

**$ARGUMENTS**

Consider:

1. Similar titles or descriptions
2. Same error messages or symptoms
3. Related functionality or components
4. Similar feature requests or bug reports

Please list any matching issues with:

- Issue number and title
- Brief explanation of why it matches the query
- Link to the issue

If no clear matches are found, say so clearly.

Use: `gh issue list --search "$ARGUMENTS" --state all --json number,title,url,state,body --limit 20`
