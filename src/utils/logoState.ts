/**
 * UA: 全局 Logo 布局模式状态
 * 用于 /logo 命令实时切换精简/完整布局，无需重启
 */
import { EventEmitter } from 'events'

const emitter = new EventEmitter()

// true = 完整布局（Tips + Recent activity）; false = 精简模式
let _isFullLogo = true

export function isFullLogoMode(): boolean {
  return _isFullLogo
}

export function setFullLogoMode(full: boolean): void {
  if (_isFullLogo !== full) {
    _isFullLogo = full
    emitter.emit('change', _isFullLogo)
  }
}

export function toggleLogoMode(): boolean {
  setFullLogoMode(!_isFullLogo)
  return _isFullLogo
}

export function onLogoModeChange(listener: (isFull: boolean) => void): () => void {
  emitter.on('change', listener)
  return () => emitter.off('change', listener)
}
