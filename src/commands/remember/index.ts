import type { Command } from '../../commands.js'

// UA: /remember 命令 — 快速将信息追加到记忆文件，实现跨会话记忆持久化
const remember: Command = {
  type: 'local',
  name: 'remember',
  description:
    'Persist information across sessions. Usage: /remember <content> [--project|--user]',
  argumentHint: '<content> [--project|--user]',
  isEnabled: () => true,
  supportsNonInteractive: false,
  load: () => import('./remember.js'),
}

export default remember
