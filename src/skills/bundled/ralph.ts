import { registerBundledSkill } from '../bundledSkills.js'

const RALPH_PROMPT = `# Ralph 模式 — 持续执行直到完成

你处于 Ralph 模式。Ralph 模式的核心原则：**不达目标誓不罢休**。

## 工作规则

1. **立即制定计划**：开始前，用 checklist 格式写下完整的执行计划。每个步骤必须是可验证的具体行动。

2. **逐项执行**：按序执行每个 checklist 项目：
   - 执行步骤
   - 验证结果
   - 打勾 ✅ 标记完成

3. **遇到错误立即修复**：
   - 不跳过任何错误
   - 不留下"待处理"的问题
   - 修复后重新验证

4. **强制完成标准**：
   - 所有 checklist 项全部打勾
   - 代码可以构建/运行
   - 没有遗留的 TODO 或 FIXME
   - 用户的原始请求已完全实现

5. **完成时输出 DONE**：当所有任务完成后，在回复末尾明确写出 **DONE**。

## 执行模板

\`\`\`
## 执行计划

- [ ] 步骤 1: ...
- [ ] 步骤 2: ...
- [ ] 步骤 3: ...
- [ ] 验证: ...

---

[开始执行...]

- [x] 步骤 1: 完成 ✅
- [x] 步骤 2: 完成 ✅
...

**DONE** — 所有任务已完成并验证。
\`\`\`

## 注意事项

- 如果发现任务范围比预期大，扩展计划而不是缩减目标
- 并行执行不相互依赖的任务（在一次回复中调用多个工具）
- 遇到权限或环境问题，先尝试解决，无法解决时才告知用户
`

/**
 * Registers the /ralph bundled skill.
 *
 * Inspired by the ralph loop mechanism from oh-my-openagent.
 * Activates a persistent execution mode where the model continues working
 * until the task is fully complete, using a checklist-based approach.
 */
export function registerRalphSkill(): void {
  registerBundledSkill({
    name: 'ralph',
    description:
      '持续执行任务直到完全完成。使用 checklist 追踪进度，遇到错误立即修复，不达目标不停止。',
    aliases: ['ralph-loop', 'rl'],
    whenToUse:
      'Use when the user wants a task completed end-to-end without interruption. Good for multi-step implementation tasks, bug fixing with verification, or any task where "done" means fully verified and working.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = RALPH_PROMPT
      if (args) {
        prompt += `\n\n## 任务\n\n${args}`
      } else {
        prompt +=
          '\n\n## 任务\n\n请根据对话上下文理解需要完成的任务，然后立即开始执行。'
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
