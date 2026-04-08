import type { Command } from '../../commands.js'

const logo: Command = {
  type: 'local',
  name: 'logo',
  description: 'Toggle full/condensed logo layout (Tips + Recent activity panels)',
  isEnabled: () => true,
  supportsNonInteractive: false,
  load: () => import('./logo.js'),
}

export default logo
