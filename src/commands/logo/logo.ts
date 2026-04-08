import type { LocalCommandCall } from '../../types/command.js'
import { toggleLogoMode, isFullLogoMode } from '../../utils/logoState.js'

export const call: LocalCommandCall = async () => {
  const isNowFull = toggleLogoMode()
  return {
    type: 'text' as const,
    value: isNowFull
      ? 'Logo layout: full (Tips + Recent activity panels).'
      : 'Logo layout: condensed (input box only).',
  }
}
