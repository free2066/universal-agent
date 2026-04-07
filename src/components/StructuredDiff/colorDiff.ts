// @ts-nocheck
/**
 * colorDiff.ts — UA 替换版
 *
 * CC 原版从 color-diff-napi（Rust NAPI）导入，UA 里没有该原生模块。
 * 改为从 UA 的纯 TypeScript 实现导入，接口完全兼容。
 */
import {
  ColorDiff,
  ColorFile,
} from '../../native-ts/color-diff/index.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export type { SyntaxTheme } from '../../native-ts/color-diff/index.js'
export type ColorModuleUnavailableReason = 'env'

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return getColorModuleUnavailableReason() === null ? ColorFile : null
}

export function getSyntaxTheme(themeName: string): any {
  if (getColorModuleUnavailableReason() !== null) return null
  try {
    // UA TS 实现里有 getSyntaxTheme
    const { getSyntaxTheme: gst } = require('../../native-ts/color-diff/index.js')
    return gst ? gst(themeName) : null
  } catch {
    return null
  }
}
