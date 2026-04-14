import type { Output } from './types.js'

export function renderToolResultMessage(
  content: Output,
  _progressMessages: unknown[],
  _options: {
    style?: 'condensed'
    theme: string
    tools: Record<string, unknown>
    verbose: boolean
    isTranscriptMode?: boolean
    isBriefOnly?: boolean
    input?: unknown
  },
): string {
  const lines: string[] = []

  if (content.message) {
    lines.push(content.message)
  }

  if (content.intercepted && content.intercepted.length > 0) {
    lines.push(`Intercepted ${content.intercepted.length} requests`)
    for (const req of content.intercepted.slice(0, 10)) {
      const body = req.responseJson
        ? ` [JSON: ${JSON.stringify(req.responseJson).slice(0, 80)}]`
        : req.responseBody
          ? ` [${req.responseBody.length}b]`
          : ''
      lines.push(`  ${req.method} ${req.url}${body}`)
    }
    if (content.intercepted.length > 10) {
      lines.push(`  ... and ${content.intercepted.length - 10} more`)
    }
  }

  if (content.dom?.title || content.dom?.url) {
    lines.push(`Page: ${content.dom.title ?? content.dom.url ?? ''}`)
  }

  if (content.evalResult !== null && content.evalResult !== undefined) {
    const evalStr = typeof content.evalResult === 'string'
      ? content.evalResult
      : JSON.stringify(content.evalResult)
    lines.push(`Eval: ${evalStr.slice(0, 200)}`)
  }

  if (content.errors && content.errors.length > 0) {
    lines.push(`Errors: ${content.errors.join(', ')}`)
  }

  return lines.join('\n') || 'No output'
}
