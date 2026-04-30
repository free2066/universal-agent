/**
 * src/services/lsp/collectDiagnostics.ts
 *
 * G2: Active LSP diagnostics collection after file writes.
 *
 * Inspired by opencode's write.ts: after writing a file, wait up to timeoutMs
 * for LSP diagnostics to arrive, then format them into a <lsp_diagnostics>
 * block that gets injected into the tool result so the AI sees errors immediately.
 *
 * This transforms LSP feedback from passive (hook reminder) to active (inline result).
 */

import { checkForLSPDiagnostics } from './LSPDiagnosticRegistry.js'
import type { Diagnostic, DiagnosticFile } from '../diagnosticTracking.js'

const MAX_ERRORS_PER_FILE = 10
const MAX_OTHER_FILES = 3

/**
 * Wait up to `timeoutMs` for LSP diagnostics to arrive after a file write,
 * then return a formatted string to append to the tool result.
 *
 * Returns null if no errors were found (warnings/hints are suppressed to avoid noise).
 */
export async function collectLSPDiagnosticsForFile(
  filePath: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  const normalizedUri = `file://${filePath}`

  // Poll for diagnostics — LSP server may take a moment to process the file
  const pollInterval = 200
  const maxPolls = Math.ceil(timeoutMs / pollInterval)

  let currentFile: DiagnosticFile | undefined
  let otherFiles: DiagnosticFile[] = []

  for (let i = 0; i <= maxPolls; i++) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    const pending = checkForLSPDiagnostics()
    if (pending.length === 0) continue

    const allFiles = pending.flatMap(p => p.files)

    // Optimized: single pass to find current file and other files
    currentFile = undefined
    otherFiles = []
    for (const f of allFiles) {
      if (f.uri === normalizedUri || f.uri === filePath) {
        currentFile = f
      } else if (otherFiles.length < MAX_OTHER_FILES) {
        otherFiles.push(f)
      }
    }

    // Check if we have any errors (severity === 'Error' or severity === 1)
    const hasErrors = (f: DiagnosticFile) =>
      f.diagnostics.some(d => d.severity === 'Error' || d.severity === 1)

    if (
      (currentFile && hasErrors(currentFile)) ||
      otherFiles.some(hasErrors)
    ) {
      break
    }
  }

  // Format diagnostics into <lsp_diagnostics> block
  const parts: string[] = []

  const formatDiag = (diag: Diagnostic): string => {
    const loc = diag.range
      ? `line ${(diag.range.start?.line ?? 0) + 1}`
      : ''
    const code = diag.code ? ` [${diag.code}]` : ''
    const source = diag.source ? ` (${diag.source})` : ''
    return `  ${loc}: ${diag.message}${code}${source}`
  }

  const isError = (d: Diagnostic) => d.severity === 'Error' || d.severity === 1

  if (currentFile) {
    const errors = currentFile.diagnostics.filter(isError)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_ERRORS_PER_FILE)
      const suffix = errors.length > MAX_ERRORS_PER_FILE
        ? `\n  ... and ${errors.length - MAX_ERRORS_PER_FILE} more errors`
        : ''
      parts.push(
        `<lsp_diagnostics file="${filePath}">\n` +
        limited.map(formatDiag).join('\n') +
        suffix +
        '\n</lsp_diagnostics>'
      )
    }
  }

  for (const file of otherFiles) {
    const errors = file.diagnostics.filter(isError)
    if (errors.length === 0) continue
    const displayPath = file.uri.replace('file://', '')
    const limited = errors.slice(0, MAX_ERRORS_PER_FILE)
    const suffix = errors.length > MAX_ERRORS_PER_FILE
      ? `\n  ... and ${errors.length - MAX_ERRORS_PER_FILE} more errors`
      : ''
    parts.push(
      `<lsp_diagnostics file="${displayPath}">\n` +
      limited.map(formatDiag).join('\n') +
      suffix +
      '\n</lsp_diagnostics>'
    )
  }

  if (parts.length === 0) return null

  return (
    '\n\n⚠️ LSP errors detected — please fix before proceeding:\n\n' +
    parts.join('\n\n')
  )
}
