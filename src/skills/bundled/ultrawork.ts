import { registerBundledSkill } from '../bundledSkills.js'

const ULTRAWORK_PROMPT = `# Ultrawork 模式 — 最大并行化执行

你处于 Ultrawork 模式。这是最高性能执行模式，专为复杂的多步骤任务设计。

## 核心原则

### 1. 并行优先（最重要）
**在一次回复中调用尽可能多的工具**。不要等待一个工具完成后再调用下一个。

✅ 正确示例：
- 一次回复中同时读取 10 个文件
- 同时运行多个独立的搜索命令
- 同时启动多个分析任务

❌ 错误示例：
- 读一个文件，等结果，再读下一个
- 串行执行可以并行的操作

### 2. 不求确认，直接执行
- 有把握的改动：直接执行
- 无把握的破坏性操作：先备份，再执行
- 不要为每个步骤请求用户确认

### 3. 批量操作
- 一次性识别所有需要修改的文件
- 批量读取，批量修改
- 减少来回次数

### 4. 彻底完成
- 不是"差不多完成"，是完全完成
- 必须包含验证步骤（构建/测试/运行）
- 所有边界情况处理完毕

## 执行流程

\`\`\`
阶段 1 [单次并行调用] — 全量信息收集
  → 读取所有相关文件
  → 搜索所有相关代码
  → 了解完整依赖关系

阶段 2 [分析] — 制定完整实施方案
  → 识别所有需要修改的位置
  → 确定修改顺序（有依赖的先做）

阶段 3 [批量执行] — 尽量在最少次数的工具调用轮次内完成
  → 独立的修改并行执行
  → 有依赖的修改按序执行

阶段 4 [验证] — 确认完成
  → 运行构建/测试
  → 检查结果
\`\`\`

## 时间感知
- 每次工具调用都有成本，最小化调用轮次
- 优先使用能一次返回更多信息的工具
- 避免"探索式"调用（先搜一下，再决定怎么搜）
`

/**
 * Registers the /ultrawork bundled skill.
 *
 * Inspired by the ultrawork mode from oh-my-openagent.
 * Activates maximum-parallelism execution mode where the model batches
 * as many tool calls as possible per turn to complete complex tasks
 * in the fewest possible rounds.
 */
export function registerUltraworkSkill(): void {
  registerBundledSkill({
    name: 'ultrawork',
    description:
      '最大并行化执行模式。在单次回复中调用尽可能多的工具，批量读写文件，减少来回次数，快速完成复杂任务。',
    aliases: ['ulw', 'ultrawork-mode'],
    whenToUse:
      'Use when a task requires many parallel operations: reading multiple files, making changes across many locations, or any complex multi-file task. Maximizes tool call parallelism to complete work in the fewest rounds.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = ULTRAWORK_PROMPT
      if (args) {
        prompt += `\n\n## 任务\n\n${args}`
      } else {
        prompt +=
          '\n\n## 任务\n\n请根据对话上下文理解需要完成的任务，然后立即以最大并行度开始执行。'
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
