/**
 * Centralized utilities for parsing slash commands
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

/**
 * Parses a slash command input string into its component parts
 *
 * @param input - The raw input string (should start with '/')
 * @returns Parsed command name, args, and MCP flag, or null if invalid
 *
 * @example
 * parseSlashCommand('/search foo bar')
 * // => { commandName: 'search', args: 'foo bar', isMcp: false }
 *
 * @example
 * parseSlashCommand('/mcp:tool (MCP) arg1 arg2')
 * // => { commandName: 'mcp:tool (MCP)', args: 'arg1 arg2', isMcp: true }
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // Check if input starts with '/'
  if (!trimmedInput.startsWith('/')) {
    return null
  }

  // Remove the leading '/' and split by spaces
  const withoutSlash = trimmedInput.slice(1)
  const spaceIdx = withoutSlash.indexOf(' ')
  const firstWord = spaceIdx >= 0 ? withoutSlash.slice(0, spaceIdx) : withoutSlash

  if (!firstWord) {
    return null
  }

  let commandName = firstWord
  let isMcp = false
  let argsStr = spaceIdx >= 0 ? withoutSlash.slice(spaceIdx + 1) : ''

  // Check for MCP commands (second word is '(MCP)')
  const mcpPrefix = '(MCP)'
  if (argsStr.startsWith(mcpPrefix) && (argsStr.length === mcpPrefix.length || argsStr[mcpPrefix.length] === ' ')) {
    commandName = firstWord + ' (MCP)'
    isMcp = true
    argsStr = argsStr.slice(mcpPrefix.length).trimStart()
  }

  const args = argsStr

  return {
    commandName,
    args,
    isMcp,
  }
}
