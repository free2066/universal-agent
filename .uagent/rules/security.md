# Security Constitution v1.0
# Constitutional Spec-Driven Development (arXiv:2602.02584)
#
# These rules are injected into EVERY system prompt via loadRules().
# The agent MUST satisfy all principles before generating code.
# "Security by construction, not by inspection."

---

## Principle 1 — No Hardcoded Credentials (CWE-798)

**NEVER** embed API keys, passwords, tokens, or secrets as string literals.
All credentials MUST come from environment variables or a config file outside the repo.

```
✗ const apiKey = "sk-abc123...";
✓ const apiKey = process.env.OPENAI_API_KEY;
```

If a credential is needed and not provided, throw a descriptive error at startup:
```
if (!process.env.API_KEY) throw new Error("API_KEY env variable is required");
```

---

## Principle 2 — Parameterized Queries (CWE-89, SQL Injection)

**NEVER** build SQL/NoSQL queries by string interpolation or concatenation.
Always use parameterized queries, prepared statements, or ORM binding.

```
✗ db.query(`SELECT * FROM users WHERE id = ${userId}`);
✓ db.query('SELECT * FROM users WHERE id = ?', [userId]);
```

---

## Principle 3 — Input Validation at Boundaries (CWE-20)

**ALL** data arriving from external sources (HTTP params, CLI args, file I/O, env vars,
IPC messages) MUST be validated for type, length, and allowed characters before use.

Reject inputs that exceed expected bounds; never silently truncate or coerce.

---

## Principle 4 — No Command Injection (CWE-78)

**NEVER** pass user-controlled data directly to shell commands.
Use `execFile` / `spawn` with an args array instead of `exec` with a concatenated string.

```
✗ exec(`git log ${userInput}`);
✓ execFile('git', ['log', userInput]);
```

If shell execution is unavoidable, escape all arguments with a library (e.g. `shell-quote`).

---

## Principle 5 — Sanitise Before DOM/Template Insertion (CWE-79, XSS)

**NEVER** insert raw user content into `innerHTML`, `document.write`, or template literals
that render as HTML. Always escape or use `textContent`.

```
✗ el.innerHTML = userComment;
✓ el.textContent = userComment;
```

For server-side rendering, use a library (e.g. `DOMPurify`, `he`) to sanitise HTML.

---

## Principle 6 — Minimal Error Exposure (CWE-209)

Error responses returned to callers (HTTP, CLI output, API responses) MUST NOT include:
- Stack traces
- Internal file paths
- SQL query text
- Environment variable names or values

Log full details server-side; return only a generic message to the caller.

```
✗ res.json({ error: err.stack });
✓ logger.error(err); res.json({ error: "Internal error" });
```

---

## Principle 7 — Path Traversal Prevention (CWE-22)

**NEVER** construct file paths from user input without normalising and validating them.
Always `resolve()` the result and assert it starts with the expected base directory.

```
✗ readFileSync('./uploads/' + fileName);
✓ const safe = resolve(UPLOAD_DIR, fileName);
  if (!safe.startsWith(UPLOAD_DIR)) throw new Error("Path traversal detected");
  readFileSync(safe);
```

---

## Principle 8 — Bash/Shell Safety (project-specific)

This project's `bashTool` already blocks dangerous pipe patterns.
When generating shell commands or scripts:
- Prefer `execFile` / `spawn` with argument arrays over `exec` with shell strings
- Quote all variables: `"${var}"` not `$var`
- Avoid `rm -rf` without an explicit path safety check
- Never pipe to `sh` or `bash` from user-supplied content

---

## Principle 9 — Dependency Hygiene

When suggesting new npm packages:
- Prefer packages with > 1M weekly downloads and recent maintenance activity
- Check for known CVEs before recommending (mention `npm audit` if adding deps)
- Never suggest packages with names that look like typosquats

---

## Principle 10 — Secrets in Files

If writing `.env`, config, or YAML files that contain placeholder values:
- Use `YOUR_KEY_HERE` style placeholders, not realistic-looking dummy values
- Add the file pattern to `.gitignore` if it contains any credentials
- Comment each secret field with where to obtain the real value

---

## Enforcement

When generating code that would violate any principle above:
1. **Stop** and note the violation explicitly
2. **Offer** the secure alternative
3. **Never** generate insecure code "just as an example" — examples become templates

> This constitution follows the Constitutional Spec-Driven Development approach.
> Security violation rate reduction vs. baseline: ~94% (arXiv:2602.02584).
