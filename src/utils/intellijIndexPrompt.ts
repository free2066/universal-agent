/**
 * IntelliJ Index MCP server integration.
 * Provides guidance for using IntelliJ IDE tools correctly.
 */

export const INTELLIJ_INDEX_MCP_SERVER_NAME = 'intellij-index'

/**
 * Tool usage instructions for the intellij-index MCP server.
 * Injected into the system prompt when the server is connected.
 *
 * Addresses common errors:
 * - Missing required parameter: query (should use `query` not `pattern`/`include`)
 * - Wrong tool choice (ide_search_text vs ide_find_file)
 * - ToolSearch matching failures for deferred tools
 */
export const INTELLIJ_INDEX_TOOL_INSTRUCTIONS = `**IMPORTANT: IntelliJ Index MCP tools (mcp__intellij-index__*)**

Before using any intellij-index tool, understand the available tools and their parameters:

## Available Tools

### ide_search_text
Search for text patterns in indexed source files.
- **Required**: \`query\` (string) — the text string to search for
- **Optional**: \`project_path\` (string) — absolute path to the project root (e.g. "/Users/guozhongming/kuaishou-java/my-project")
- **Optional**: \`include\` (string) — file glob pattern to narrow scope (e.g. "**/*.java")

DO NOT use \`pattern\` — use \`query\` for the search text.
Example: \`{ "query": "FlowDAG", "project_path": "/path/to/project" }\`

### ide_find_file
Find files by name pattern.
- **Required**: \`query\` (string) — the filename or pattern to search
- **Optional**: \`project_path\` (string) — absolute path to the project root

Example: \`{ "query": "JobConfig.java", "project_path": "/path/to/project" }\`

### ide_read_file
Read file contents from the IDE's indexed file system.
- **Required**: \`file\` (string) — absolute file path
- **Optional**: \`project_path\` (string) — absolute path to the project root
- **Optional**: \`offset\`, \`limit\` — for partial reads

Example: \`{ "file": "/path/to/JobConfig.java", "project_path": "/path/to/project" }\`

### ide_diagnostics
Show IDE diagnostics (warnings, errors) for a file.
- **Required**: \`file_path\` (string) — relative or absolute file path
- **Optional**: \`project_path\` (string) — absolute path to the project root

### ide_find_class, ide_find_method
Find classes/methods by name in the project.
- **Required**: \`query\` (string) — the class or method name
- **Optional**: \`project_path\` (string)

### ide_goto
Navigate to a specific file and line.
- **Required**: \`file\` (string), \`line\` (number)
- **Optional**: \`project_path\` (string)

## Common Mistakes to Avoid

1. **Wrong parameter name**: ide_search_text requires \`query\`, NOT \`pattern\` or \`include\` for the search text. Only \`include\` is for file glob filtering.
2. **Confusing tools**: Use ide_find_file for finding files by name, ide_search_text for finding text in files.
3. **Index not populated**: IntelliJ Index MCP relies on the IDE's indexed data. If results are empty (totalCount:0), the project may not be fully indexed in IntelliJ — try opening the project in IntelliJ first and waiting for indexing to complete.
4. **Wrong project_path**: Always use the absolute path to the project root (e.g. "/Users/guozhongming/kuaishou-java/kwaibi-service"), not relative paths.

## When Results Are Empty

If a search returns \`matches:[]\` or \`totalCount:0\`:
- The text may not exist in the indexed project
- The project may not be open in IntelliJ (required for indexing)
- Try a different search term or use a broader pattern`
