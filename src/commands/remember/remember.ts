// @ts-nocheck
import { appendFile, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'
import type { LocalCommandCall } from '../../types/command.js'
import { getMemoryPath } from '../../utils/config.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'

/**
 * UA: /remember 命令 — 快速将信息追加到记忆文件，实现跨会话记忆持久化
 *
 * 用法:
 *   /remember <内容>              → 追加到 CLAUDE.local.md（个人记忆，不入 git）
 *   /remember --project <内容>    → 追加到 CLAUDE.md（项目记忆，入 git）
 *   /remember --user <内容>       → 追加到 ~/.claude/CLAUDE.md（全局用户记忆）
 *
 * 示例:
 *   /remember API 密钥路径在 ~/.uagent/.env
 *   /remember --project 构建命令是 bun run build
 *   /remember --user 我喜欢简洁的回答，不要重复已知内容
 */

// 解析参数，返回 { target, content }
function parseArgs(args: string): {
  target: 'Local' | 'Project' | 'User'
  content: string
} {
  const trimmed = args.trim()

  if (trimmed.startsWith('--project ')) {
    return { target: 'Project', content: trimmed.slice('--project '.length).trim() }
  }
  if (trimmed.startsWith('--user ')) {
    return { target: 'User', content: trimmed.slice('--user '.length).trim() }
  }
  // 默认写入 CLAUDE.local.md（个人，不入 git）
  return { target: 'Local', content: trimmed }
}

function getTargetLabel(target: 'Local' | 'Project' | 'User'): string {
  switch (target) {
    case 'Local':
      return 'CLAUDE.local.md（个人记忆）'
    case 'Project':
      return 'CLAUDE.md（项目记忆）'
    case 'User':
      return '~/.claude/CLAUDE.md（全局记忆）'
  }
}

export const call: LocalCommandCall = async (args, _context) => {
  if (!args || !args.trim()) {
    return {
      type: 'text',
      text: [
        '用法: /remember <内容>',
        '',
        '选项:',
        '  /remember <内容>            追加到 CLAUDE.local.md（个人记忆，不入 git）',
        '  /remember --project <内容>  追加到 CLAUDE.md（项目记忆，入 git）',
        '  /remember --user <内容>     追加到 ~/.claude/CLAUDE.md（全局用户记忆）',
        '',
        '示例:',
        '  /remember API 密钥路径在 ~/.uagent/.env',
        '  /remember --project 构建命令是 bun run build',
        '  /remember --user 我喜欢简洁的回答',
      ].join('\n'),
    }
  }

  const { target, content } = parseArgs(args)
  const memoryPath = getMemoryPath(target)

  if (!content) {
    return {
      type: 'text',
      text: `错误: 内容不能为空。用法: /remember [--project|--user] <内容>`,
    }
  }

  try {
    // 确保目录存在
    const dir = dirname(memoryPath)
    await mkdir(dir, { recursive: true })

    // 检查文件是否已存在，决定是否加前缀换行
    const fileExists = existsSync(memoryPath)
    let existingContent = ''
    if (fileExists) {
      existingContent = await readFile(memoryPath, 'utf8')
    }

    // 如果文件不存在，创建带 UA Memory 标题的初始内容
    if (!fileExists || !existingContent.trim()) {
      const initialContent = target === 'User'
        ? `# 全局用户记忆\n\n<!-- 由 /remember 命令自动维护 -->\n\n## 记忆条目\n\n`
        : target === 'Project'
        ? `# 项目记忆\n\n<!-- 由 /remember 命令自动维护，此文件应提交到 git -->\n\n## 记忆条目\n\n`
        : `# 个人记忆\n\n<!-- 由 /remember 命令自动维护，此文件不应提交到 git -->\n\n## 记忆条目\n\n`
      await writeFile(memoryPath, initialContent, 'utf8')
    }

    // 生成带时间戳的记忆条目
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
    const entry = `- [${timestamp}] ${content}\n`

    // 追加到文件
    await appendFile(memoryPath, entry, 'utf8')

    // 清除 claudemd 缓存，让下次读取时能拿到最新内容
    clearMemoryFileCaches()

    return {
      type: 'text',
      text: `已记住: "${content}"\n→ 写入 ${getTargetLabel(target)}\n→ 路径: ${memoryPath}`,
    }
  } catch (err: any) {
    return {
      type: 'text',
      text: `写入失败: ${err?.message ?? err}`,
    }
  }
}
