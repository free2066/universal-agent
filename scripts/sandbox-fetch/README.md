# sandbox-fetch

Browser sandbox with CDP network interception for universal-agent.

## Quick Start

```bash
cd scripts/sandbox-fetch
npm install

# Run (Chrome must be in PATH as "Google Chrome" on macOS or "google-chrome-stable"/"chromium" on Linux)
node sandbox-fetch.mjs \
  --url "https://example.com" \
  --intercept "**/api/**" \
  --output .output/result.json
```

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--url` | Target URL to navigate to | **Required** |
| `--intercept` | URL pattern(s) to intercept (repeatable) | `**/api/**, **/data/**` |
| `--cookies` | Cookies to inject (`name=value;name2=value2`) | none |
| `--output` | Output file path (JSON) | stdout |
| `--cdp-port` | Chrome Debug port | 9222 |
| `--wait-ms` | Max time to wait for data | 60000 |
| `--settle-ms` | Stability threshold (no new requests) | 5000 |
| `--max-requests` | Max intercepted requests | 200 |
| `--chrome-path` | Path to Chrome binary | auto-detect |

## How It Works

1. **Auto-launch Chrome** in Debug Mode if not already running
2. **CDP Network interception** — captures `requestWillBeSent` / `responseReceived` / `loadingFinished`
3. **JS injection** — adds fetch/XHR monkey-patch as fallback when page uses Workers
4. **Cookie injection** — sets auth cookies via `Network.setCookie` before navigation
5. **Stability wait** — waits for no new requests for 5 seconds before collecting results
6. **Output** — JSON with intercepted requests/responses, DOM title/text

## Output Format

```json
{
  "url": "https://example.com/dashboard",
  "timestamp": "2026-04-14T...",
  "intercepted": [
    {
      "url": "https://example.com/api/v1/data",
      "method": "POST",
      "request": { "headers": {}, "postData": "..." },
      "response": { "status": 200, "headers": {}, "mimeType": "application/json" },
      "responseBody": "{...}",
      "responseJson": { ... },
      "timestamp": 1234567890
    }
  ],
  "dom": {
    "title": "Dashboard",
    "url": "https://example.com/dashboard",
    "text": "..."
  },
  "errors": []
}
```

## For universal-agent Integration

Agent can call via BashTool:

```
bash node scripts/sandbox-fetch/sandbox-fetch.mjs \
  --url "https://kwaibi.corp.kuaishou.com/dashboard/123" \
  --intercept "**/api/v1/**" \
  --cookies "token=$AUTH_TOKEN;user=$USER" \
  --output .output/sandbox.json \
  --wait-ms 90000
```

## Requirements

- Node.js >= 18.0.0
- Google Chrome or Chromium installed
- `ws` npm package (auto-installed via package.json)
