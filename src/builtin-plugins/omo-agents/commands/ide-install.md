---
description: "Detect the current IDE and install the Claude Code extension"
argument-hint: "[--list|--check|--force]"
---

# IDE Extension Installer

You are helping the user install the **Claude Code** extension for their IDE.

## IDE Detection & Installation

Use the IdeService to:

```javascript
import { getIdeService } from './src/services/ide/index.js'
const ide = getIdeService()
```

### Step 1: Detect current IDE
```javascript
const detected = ide.detect()
// Returns: { name, cmd, extensionId } or null
```

### Step 2: Check extension status
```javascript
const isInstalled = detected ? await ide.isExtensionInstalled(detected) : false
const cliAvailable = detected ? await ide.isCLIAvailable(detected) : false
```

### Step 3: Install if needed
```javascript
if (detected && !isInstalled) {
  await ide.install(detected)
}
```

## Supported IDEs

| IDE | CLI Command | Extension |
|-----|-------------|-----------|
| Visual Studio Code | `code` | anthropic.claude-code |
| VS Code Insiders | `code-insiders` | anthropic.claude-code |
| Cursor | `cursor` | anthropic.claude-code |
| Windsurf | `windsurf` | anthropic.claude-code |
| VSCodium | `codium` | anthropic.claude-code |

## Manual Installation Instructions

If CLI detection fails, provide these manual steps:

**VS Code / Cursor / Windsurf:**
1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Type "Extensions: Install Extensions"
3. Search for "Claude Code" by Anthropic
4. Click Install

**Or via CLI:**
```bash
code --install-extension anthropic.claude-code
cursor --install-extension anthropic.claude-code
windsurf --install-extension anthropic.claude-code
```

## Task

Based on `$ARGUMENTS`:
- **No args / default**: Auto-detect IDE and install if not present
- **--list**: Show all supported IDEs and their detection status
- **--check**: Report the currently detected IDE and extension status (no install)
- **--force**: Re-install even if already installed

Run the detection and provide the user with clear status output.
