#!/usr/bin/env bun
// Universal Agent CLI - runs source directly with Bun
// This avoids React bundling conflicts from bun build
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const srcEntry = join(__dirname, '../src/entrypoints/cli.tsx')

await import(srcEntry)
