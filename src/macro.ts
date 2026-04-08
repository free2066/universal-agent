/**
 * MACRO — 编译时常量，在 Bun 构建时通过 --define 注入
 * 运行时 fallback 从 package.json 读取
 */

declare global {
  const MACRO: {
    VERSION: string
    VERSION_CHANGELOG: string
    ISSUES_EXPLAINER: string
  }
}

// Runtime fallback when MACRO is not injected by Bun build
// Read version dynamically from package.json to avoid stale hardcoded value
;(function initMACRO() {
  if ((globalThis as any).MACRO) return
  let version = '1.2.8'
  try {
    // In Bun runtime, __dirname is available
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    // Try to read package.json next to the dist file
    const pkgPaths = [
      resolve(__dirname, '../../package.json'),
      resolve(__dirname, '../package.json'),
      resolve(process.cwd(), 'package.json'),
    ]
    for (const p of pkgPaths) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'))
        if (pkg.version) { version = pkg.version; break }
      } catch {}
    }
  } catch {}
  ;(globalThis as any).MACRO = {
    VERSION: version,
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: 'visit https://github.com/free2066/universal-agent/issues',
  }
})()
