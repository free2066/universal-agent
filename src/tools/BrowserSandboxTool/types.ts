import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

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

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string().describe('The action performed'),
    success: z.boolean().describe('Whether the action succeeded'),
    intercepted: z
      .array(
        z.object({
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
  }).catchall(z.unknown()),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>
export type Output = z.infer<ReturnType<typeof outputSchema>>
