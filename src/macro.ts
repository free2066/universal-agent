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
// This file must be imported early, before any MACRO usage
;(globalThis as any).MACRO ??= {
  VERSION: '0.5.23',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: 'visit https://github.com/free2066/universal-agent/issues',
}

export {}
