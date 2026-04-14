export const BROWSER_SANDBOX_TOOL_NAME = 'browser_sandbox'

export const DESCRIPTION = `
Controls a headless browser via Chrome DevTools Protocol (CDP) to intercept network requests,
navigate pages, and extract data from complex web applications.

## Core Actions

- **intercept** (default): Navigate to a URL and intercept matching network requests/responses.
  Waits for data to stabilize before returning. Best for capturing API calls made by SPAs.
- **navigate**: Navigate to a URL without intercepting (just loads the page).
- **snapshot**: Get current DOM state (title, text, visible elements).
- **eval**: Execute JavaScript in the page context and return the result.
- **click**: Click an element by CSS selector (use snapshot first to find selectors).
- **inject_cookies**: Inject authentication cookies before navigation.
- **launch**: Launch a fresh Chrome instance (or connect to existing one on port 9222).

## Network Interception

The \`intercept\` action captures:
- All HTTP request/response pairs matching \`interceptPatterns\`
- Response bodies (auto-detected for JSON, text, HTML)
- Parsed JSON bodies (\`responseJson\` field)
- Timing information

**Best patterns for data products:**
- \`**/api/v1/**\` — captures most internal API calls
- \`**/data/query**\` — kwaibi-style data query endpoints
- \`**/graphql**\` — GraphQL endpoints

## Cookie Injection

Use \`cookies\` parameter to inject authentication cookies. Format:
\`[{ name: "token", value: "abc123", domain: ".example.com" }]\`

This bypasses login pages by injecting the auth session directly.

## Common Workflow

1. \`launch\` (or omit — a Chrome instance is started automatically on first intercept)
2. \`inject_cookies\` with auth cookies (optional, for internal sites)
3. \`intercept\` with the target URL and patterns
4. Parse the \`intercepted\` array in the response — each entry has \`url\`, \`method\`, \`responseJson\`, etc.

## Tips

- Use \`settleMs\` (default 5000) to control how long to wait after the last request.
- Use \`maxRequests\` (default 200) to limit captured requests.
- For complex SPAs (kwaibi, Tableau, etc.), intercept patterns like \`**/query**\` or \`**/data**\`
  capture the actual data payloads that power the visualizations.
- Results are returned as structured JSON — extract \`responseJson\` from each intercepted
  request to get the raw data.

## Limitations

- Chrome must be installed (Google Chrome or Chromium)
- Cannot bypass CAPTCHAs or advanced bot detection
- Internal corporate sites with complex SSO may need special cookie handling
`
