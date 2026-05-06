import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { BROWSER_SANDBOX_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  CDPClient,
  type ChromeHandle,
  type InterceptionCollector,
  createInterceptionCollector,
  cdpEnableNetwork,
  cdpEnablePage,
  cdpEvaluate,
  cdpInjectScript,
  cdpNavigate,
  cdpSetCookie,
  detectChromePath,
  launchChrome,
  setupNetworkListeners,
  tryExistingChrome,
  waitForChrome,
} from './cdp.js'
import {
  INTERCEPT_SCRIPT,
  JS_INTERCEPTOR_SCRIPT,
  COLLECTOR_SCRIPT,
} from './injected-scripts.js'
import {
  renderToolResultMessage,
} from './UI.js'
import type { Output } from './types.js'

const CDP_PORT = 9222

// ─── Schema ──────────────────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['launch', 'navigate', 'intercept', 'snapshot', 'eval', 'click', 'inject_cookies', 'close'])
      .default('intercept')
      .describe('The action to perform'),
    url: z.string().optional().describe('Target URL for navigate/intercept actions'),
    interceptPatterns: z
      .array(z.string())
      .optional()
      .describe('URL patterns to intercept (glob-style: **/api/**, */*.json). Defaults to common data API patterns.'),
    cookies: z
      .array(
        z.strictObject({
          name: z.string().describe('Cookie name'),
          value: z.string().describe('Cookie value'),
          domain: z.string().optional().describe('Cookie domain (defaults to the URL hostname)'),
        }),
      )
      .optional()
      .describe('Cookies to inject before navigation'),
    maxRequests: z.number().int().min(1).max(500).default(200).describe('Max number of requests to intercept'),
    settleMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(5000)
      .describe('Wait time after last request (ms) before collecting results'),
    waitMs: z
      .number()
      .int()
      .min(5000)
      .max(300000)
      .default(60000)
      .describe('Maximum time to wait for data (ms)'),
    chromePort: z.number().int().min(1).max(65535).default(9222).describe('Chrome Debug port'),
    selector: z.string().optional().describe('CSS selector for click/snapshot actions'),
    expression: z.string().optional().describe('JavaScript expression for eval action'),
    cdpPath: z.string().optional().describe('Path to Chrome binary'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string().describe('The action performed'),
    success: z.boolean().describe('Whether the action succeeded'),
    intercepted: z
      .array(
        z.strictObject({
          url: z.string().describe('Request URL'),
          method: z.string().describe('HTTP method'),
          requestBody: z.string().nullable().describe('Request body'),
          response: z
            .object({
              status: z.number(),
              statusText: z.string(),
              headers: z.record(z.string(), z.string()),
              mimeType: z.string(),
              url: z.string(),
            })
            .nullable(),
          responseBody: z.string().nullable().describe('Raw response body'),
          responseJson: z.unknown().nullable().describe('Parsed JSON body (if applicable)'),
          timestamp: z.number().nullable(),
          source: z.string(),
        }),
      )
      .describe('Intercepted network requests'),
    dom: z
      .object({
        title: z.string().nullable(),
        url: z.string().nullable(),
        text: z.string().nullable(),
      })
      .describe('DOM snapshot'),
    evalResult: z.unknown().nullable().describe('Result of eval action'),
    message: z.string().optional().describe('Human-readable status message'),
    errors: z.array(z.string()).describe('Errors encountered'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

// ─── Global Chrome/browser state ──────────────────────────────────────────────
// These are module-level singletons shared across tool calls in the same session.
// In practice, each agent turn gets a fresh context, but within a turn we may
// call the tool multiple times — keep the Chrome process alive across calls.

let _chromeHandle: ChromeHandle | null = null
let _cdpClient: CDPClient | null = null
let _interceptionCollector: InterceptionCollector | null = null
let _pageLoaded = false

// ============================================================================
// Pattern matching utilities (precompiled regex for performance)
// ============================================================================

/** Default patterns as module-level constant for reference equality check */
const DEFAULT_PATTERNS = ['**/api/**', '**/data/**', '**/query**', '**/*.json', '**/graphql**']

/** Precompiled regexes for default patterns (avoid per-call compilation) */
const DEFAULT_PATTERN_REGEXES: RegExp[] = DEFAULT_PATTERNS.map(p => {
  const escaped = p
    .replace(/\*\*/g, '\x00DBLSTAR\x00')
    .replace(/\*/g, '\x00STAR\x00')
    .replace(/[.+?()\[\]{}^$|\\]/g, '\\$&')
    .replace(/\x00DBLSTAR\x00/g, '.*')
    .replace(/\x00STAR\x00/g, '[^/]*')
  return new RegExp(escaped)
})

function getDefaultPatterns(): string[] {
  return DEFAULT_PATTERNS
}

// Cache for compiled regex patterns
const PATTERN_REGEX_CACHE = new Map<string, RegExp>()

function compilePatternToRegex(p: string): RegExp {
  let cached = PATTERN_REGEX_CACHE.get(p)
  if (!cached) {
    const escaped = p
      .replace(/\*\*/g, '\x00DBLSTAR\x00')
      .replace(/\*/g, '\x00STAR\x00')
      .replace(/[.+?()\[\]{}^$|\\]/g, '\\$&')
      .replace(/\x00DBLSTAR\x00/g, '.*')
      .replace(/\x00STAR\x00/g, '[^/]*')
    cached = new RegExp(escaped)
    PATTERN_REGEX_CACHE.set(p, cached)
  }
  return cached
}

function matchesPattern(url: string, patterns: string[]): boolean {
  // Use precompiled default patterns for performance
  if (patterns === DEFAULT_PATTERNS) {
    return DEFAULT_PATTERN_REGEXES.some(re => re.test(url))
  }
  // Fallback for custom patterns - use cached regex
  for (const p of patterns) {
    if (compilePatternToRegex(p).test(url)) return true
  }
  return false
}

// ─── Tool definition ───────────────────────────────────────────────────────────

export const BrowserSandboxTool = buildTool({
  name: BROWSER_SANDBOX_TOOL_NAME,
  searchHint: 'control browser, intercept network requests, automate web scraping',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(_input) {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Browser Sandbox'
  },
  getToolUseSummary(input: z.infer<InputSchema>) {
    switch (input.action) {
      case 'launch': return 'launching browser'
      case 'navigate': return input.url ?? 'navigating'
      case 'intercept': return `intercepting ${input.url ?? ''} (${(input.interceptPatterns ?? getDefaultPatterns()).join(', ')})`
      case 'snapshot': return 'snapshotting DOM'
      case 'eval': return `evaluating ${input.expression?.slice(0, 40) ?? ''}...`
      case 'click': return `clicking ${input.selector ?? ''}`
      case 'inject_cookies': return 'injecting cookies'
      case 'close': return 'closing browser'
      default: return 'browser sandbox'
    }
  },
  renderToolUseMessage(input: Partial<z.infer<InputSchema>>) {
    if (!input?.action) return null
    const summary = BrowserSandboxTool.getToolUseSummary!(input as z.infer<InputSchema>)
    return summary
  },
  renderToolUseErrorMessage(error: string) {
    return `Browser sandbox error: ${error}`
  },
  mapToolResultToToolResultBlockParam(data: z.infer<OutputSchema>, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: renderToolResultMessage(data as Output, [], {
        style: 'condensed',
        theme: 'dark',
        tools: {},
        verbose: false,
      }) ?? JSON.stringify(data),
    }
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    // It's a read operation — navigating + intercepting does not modify anything
    return true
  },
  async validateInput({ action, url }) {
    if ((action === 'navigate' || action === 'intercept') && !url) {
      return { result: false, message: 'URL is required for navigate/intercept actions', errorCode: 1 }
    }
    if (action === 'eval' && !url && !_pageLoaded) {
      return { result: false, message: 'No page loaded. Use intercept or navigate first.', errorCode: 2 }
    }
    return { result: true }
  },
  async call(input: z.infer<InputSchema>, _context) {
    const {
      action = 'intercept',
      url,
      interceptPatterns = getDefaultPatterns(),
      cookies,
      maxRequests = 200,
      settleMs = 5000,
      waitMs = 60000,
      chromePort = CDP_PORT,
      selector,
      expression,
      cdpPath,
    } = input

    const errors: string[] = []
    let intercepted: z.infer<OutputSchema>['intercepted'] = []
    let dom: z.infer<OutputSchema>['dom'] = { title: null, url: null, text: null }
    let evalResult: unknown = null
    let success = true

    try {
      // ── Ensure Chrome is running ───────────────────────────────────────────

      if (!_cdpClient || !_chromeHandle) {
        // Try existing Chrome first
        const existingWsUrl = await tryExistingChrome(chromePort)
        if (existingWsUrl) {
          _cdpClient = new CDPClient(existingWsUrl)
          await _cdpClient.connect()
          _chromeHandle = { process: null, port: chromePort }
        } else {
          // Launch new Chrome
          const chromeBin = cdpPath || detectChromePath()
          _chromeHandle = launchChrome(chromePort, chromeBin)
          await waitForChrome(chromePort)
          const wsUrl = await tryExistingChrome(chromePort)
          if (!wsUrl) throw new Error('Chrome failed to start')
          _cdpClient = new CDPClient(wsUrl)
          await _cdpClient.connect()
        }

        // Enable domains
        await cdpEnableNetwork(_cdpClient)
        await cdpEnablePage(_cdpClient)

        // Inject intercept script before navigation
        await cdpInjectScript(_cdpClient, INTERCEPT_SCRIPT)

        // Setup interception collector
        _interceptionCollector = createInterceptionCollector()
        setupNetworkListeners(_cdpClient, _interceptionCollector, interceptPatterns, maxRequests)

        _pageLoaded = false
      }

      // ── Action: close ────────────────────────────────────────────────────

      if (action === 'close') {
        _cdpClient?.close()
        _cdpClient = null
        if (_chromeHandle?.process) {
          _chromeHandle.process.kill('SIGTERM')
        }
        _chromeHandle = null
        _interceptionCollector = null
        _pageLoaded = false
        return { data: { action: 'close', success: true, intercepted: [], dom, errors: [] } }
      }

      // ── Action: inject_cookies ────────────────────────────────────────────

      if (action === 'inject_cookies' && cookies) {
        for (const cookie of cookies) {
          const domain = cookie.domain || (url ? new URL(url).hostname : undefined)
          if (domain) {
            await cdpSetCookie(_cdpClient!, cookie.name, cookie.value, domain)
          }
        }
        return {
          data: {
            action: 'inject_cookies',
            success: true,
            intercepted: [],
            dom,
            message: `Injected ${cookies.length} cookies`,
            errors: [],
          },
        }
      }

      // ── Action: launch ────────────────────────────────────────────────────

      if (action === 'launch') {
        return {
          data: {
            action: 'launch',
            success: true,
            intercepted: [],
            dom,
            message: `Chrome ready on port ${chromePort}`,
            errors: [],
          },
        }
      }

      // ── Actions requiring a page ─────────────────────────────────────────

      if (!_pageLoaded && (action === 'navigate' || action === 'intercept' || action === 'snapshot' || action === 'eval' || action === 'click')) {
        if (!url) {
          return {
            data: {
              action,
              success: false,
              intercepted: [],
              dom,
              message: 'No URL provided and no page is loaded',
              errors: ['No URL provided'],
            },
          }
        }

        // Inject cookies first
        if (cookies) {
          const hostname = new URL(url).hostname
          for (const cookie of cookies) {
            const domain = cookie.domain || hostname
            await cdpSetCookie(_cdpClient!, cookie.name, cookie.value, domain)
          }
        }

        // Navigate
        await cdpNavigate(_cdpClient!, url)
        _pageLoaded = true
      }

      // ── Action: click ─────────────────────────────────────────────────────

      if (action === 'click' && selector) {
        const escaped = JSON.stringify(selector)
        const result = await cdpEvaluate(_cdpClient!, `document.querySelector(${escaped})?.click()`)
        return {
          data: {
            action: 'click',
            success: true,
            intercepted: [],
            dom,
            message: `Clicked: ${selector}`,
            errors: [],
          },
        }
      }

      // ── Action: eval ─────────────────────────────────────────────────────

      if (action === 'eval') {
        const result = await cdpEvaluate(_cdpClient!, expression ?? '')
        evalResult = (result as { result?: { value?: unknown } }).result?.value
        return {
          data: {
            action: 'eval',
            success: true,
            intercepted: [],
            dom,
            evalResult,
            message: 'Evaluated expression',
            errors: [],
          },
        }
      }

      // ── Action: snapshot ──────────────────────────────────────────────────

      if (action === 'snapshot') {
        const result = await cdpEvaluate(_cdpClient!, COLLECTOR_SCRIPT)
        const raw = String((result as { result?: { value?: unknown } }).result?.value || '{}')
        try {
          const parsed = JSON.parse(raw)
          dom = parsed.dom ?? dom
        } catch { /* CDP DOM snapshot JSON parsing is best-effort */ }
        return {
          data: {
            action: 'snapshot',
            success: true,
            intercepted: [],
            dom,
            message: 'DOM snapshot taken',
            errors: [],
          },
        }
      }

      // ── Action: intercept ────────────────────────────────────────────────

      if (action === 'intercept') {
        // Reset collector for this intercept session
        if (_interceptionCollector) {
          _interceptionCollector.entries.clear()
          _interceptionCollector.lastRequestTime = Date.now()
        }

        // Navigate to URL if not already loaded
        if (url && !_pageLoaded) {
          if (cookies) {
            const hostname = new URL(url).hostname
            for (const cookie of cookies) {
              const domain = cookie.domain || hostname
              await cdpSetCookie(_cdpClient!, cookie.name, cookie.value, domain)
            }
          }
          await cdpNavigate(_cdpClient!, url)
          _pageLoaded = true
        }

        // Also inject JS intercept script as fallback
        try {
          await cdpEvaluate(_cdpClient!, JS_INTERCEPTOR_SCRIPT)
        } catch { /* CDP JS interceptor script injection is best-effort */ }

        // Wait for data to stabilize
        const startTime = Date.now()
        let lastStableTime = Date.now()

        await new Promise<void>(resolve => {
          const check = () => {
            const elapsed = Date.now() - startTime
            if (elapsed >= waitMs) {
              process.stderr.write(`[browser_sandbox] timeout after ${waitMs}ms\n`)
              resolve()
              return
            }
            const sinceLast = Date.now() - (_interceptionCollector?.lastRequestTime ?? Date.now())
            if ((_interceptionCollector?.entries.size ?? 0) > 0 && sinceLast < 1000) {
              lastStableTime = Date.now()
            }
            const stableFor = Date.now() - lastStableTime
            if ((_interceptionCollector?.entries.size ?? 0) > 0 && stableFor >= settleMs) {
              process.stderr.write(`[browser_sandbox] stable after ${elapsed}ms\n`)
              resolve()
              return
            }
            process.stderr.write(`[browser_sandbox] ${elapsed}ms: ${_interceptionCollector?.entries.size ?? 0} requests, stable for ${Date.now() - lastStableTime}ms\n`)
            setTimeout(check, 500)
          }
          setTimeout(check, 3000)
        })

        // Collect JS-intercepted data
        let jsIntercepted: Array<Record<string, unknown>> = []
        try {
          const evalResult = await cdpEvaluate(_cdpClient!, 'JSON.stringify(window.__sandboxRequests || [])')
          const val = String((evalResult as { result?: { value?: unknown } }).result?.value || '[]')
          if (val && val !== 'undefined') {
            jsIntercepted = JSON.parse(val)
          }
        } catch { /* CDP interception data parsing is best-effort */ }

        // Build final intercepted array
        const cdpEntries = Array.from((_interceptionCollector?.entries.values() ?? []).filter(e => matchesPattern(e.url, interceptPatterns)))
        const allEntries = [...cdpEntries]

        for (const jsEntry of jsIntercepted) {
          const alreadyHas = allEntries.some(
            e => e.url === jsEntry.url && Math.abs((Number(e.timestamp) || 0) - (Number(jsEntry.timestamp) || 0)) < 5000,
          )
          if (!alreadyHas) {
            allEntries.push({
              url: jsEntry.url as string,
              method: (jsEntry.method as string) || 'GET',
              requestBody: (jsEntry.requestBody as string) || null,
              response: null,
              responseBody: (jsEntry.responseText as string) || null,
              responseJson: (() => {
                try { return JSON.parse((jsEntry.responseText as string) || '') } catch { return null }
              })(),
              timestamp: (jsEntry.timestamp as number) || null,
              source: (jsEntry.source as string) || 'sandbox-js',
            })
          }
        }

        intercepted = allEntries.slice(0, maxRequests).map(e => ({
          url: e.url,
          method: e.method,
          requestBody: e.postData ?? e.requestBody ?? null,
          response: e.response ?? null,
          responseBody: e.responseBody ?? null,
          responseJson: e.responseJson ?? null,
          timestamp: e.timestamp ?? null,
          source: e.source,
        }))

        // Get DOM info
        try {
          const evalResult = await cdpEvaluate(_cdpClient!, COLLECTOR_SCRIPT)
          const val = String((evalResult as { result?: { value?: unknown } }).result?.value || '{}')
          if (val) {
            const parsed = JSON.parse(val)
            if (parsed.dom) {
              dom = {
                title: parsed.dom.title ?? null,
                url: parsed.dom.url ?? null,
                text: parsed.dom.text ?? null,
              }
            }
          }
        } catch { /* CDP DOM element extraction is best-effort */ }

        return {
          data: {
            action: 'intercept',
            success: true,
            intercepted,
            dom,
            message: `Intercepted ${intercepted.length} requests`,
            errors: [],
          },
        }
      }

      return {
        data: {
          action,
          success: true,
          intercepted,
          dom,
          message: `Action '${action}' completed`,
          errors: [],
        },
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(msg)
      success = false

      // Clean up broken state
      _cdpClient?.close()
      _cdpClient = null
      if (_chromeHandle?.process) {
        _chromeHandle.process.kill('SIGTERM')
      }
      _chromeHandle = null
      _interceptionCollector = null
      _pageLoaded = false

      return {
        data: {
          action,
          success: false,
          intercepted: [],
          dom,
          message: `Error: ${msg}`,
          errors,
        },
      }
    }
  },
})
