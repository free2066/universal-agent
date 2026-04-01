# Universal Agent CLI Bug 报告

> 📅 测试日期: 2026-04-01  
> 📁 项目路径: `/Users/guozhongming/universal-agent`  
> 📝 版本: 0.1.0

---

## 🔴 严重 Bug (High Priority)

### 1. `runREPL` 函数中的 `options` 参数引用错误
**文件**: `src/cli/index.ts` (Line 98-99)

```typescript
rl.setPrompt(chalk.cyan(`[${domain}] `) + chalk.green('❯ '));
options.domain = domain;
```

**问题**: `/domain` 命令切换 domain 后，RL 提示符被设置，但 `options.domain` 可能在某些上下文中不同步。

**修复建议**: 确保所有对 `options` 的修改在异步上下文中保持一致。

---

### 2. `expandMentions` 方法潜在的无限循环风险
**文件**: `src/core/agent.ts` (Line 322-335)

```typescript
private expandMentions(prompt: string): string {
  const hints: string[] = [];
  // 如果提示本身包含 [Hints: ...]，可能产生递归
```

**问题**: 如果 LLM 返回的内容包含 `@run-agent-xxx` 且结果被重新作为提示传入，可能造成循环代理调用。

---

### 3. `ModelManager.cycleMainModel()` 在非活跃模型间循环
**文件**: `src/models/model-manager.ts` (Line 286-292)

```typescript
cycleMainModel(): string {
  const active = this.listProfiles().map(p => p.name);
  // active 包含所有 isActive=true 的模型，但指针可能指向非活跃模型
```

**问题**: 如果 `main` 指针当前设置为非活跃模型（用户自定义但未激活），循环会跳转到下一个模型，但用户可能困惑为什么当前模型"丢失"了。

---

## 🟠 中等 Bug (Medium Priority)

### 4. `bashTool` 的 `safeMode` 检测不完整
**文件**: `src/core/tools/fs-tools.ts` (Line 118-131)

```typescript
const dangerous = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{\s*:|:\&\s*\}/,
  />\s*\/dev\/[sh]d[a-z]/,
];
```

**问题**: 
- 缺少对 `curl ... | bash`、`wget ... -O - | sh` 等管道执行的危险检测
- `> /dev/sda` 的正则表达式无法匹配 `> /dev/sda1`
- 没有检测 `sudo rm -rf /` 这种常见危险命令

**建议修复**:
```typescript
const dangerous = [
  /rm\s+-rf\s+\/.*$/,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{\s*:|:\&\s*\}/,
  />\s*\/dev\/[sh]d[a-z]\d*/,
  /\|\s*(bash|sh|zsh)\s*$/,  // 管道到 shell
  /sudo\s+rm\s+-rf/,
  /:(){ :|:& };:/,  // fork bomb
];
```

---

### 5. `Grep` 工具的参数注入漏洞
**文件**: `src/core/tools/fs-tools.ts` (Line 219-245)

```typescript
const escapedPattern = pattern.replace(/'/g, "'\"'\"'");
const cmd = [
  'grep', '-rn', caseFlag, includeFlag,
  '-E', `'${escapedPattern}'`,
  `'${searchPath}'`,
  '2>/dev/null', '| head -50',
].filter(Boolean).join(' ');
```

**问题**: `searchPath` 没有被正确转义。如果路径包含单引号，会导致命令注入。

**建议修复**:
```typescript
const escapedSearchPath = searchPath.replace(/'/g, "'\"'\"'");
// ...
`'${escapedSearchPath}'`,
```

---

### 6. `WebFetch` 没有处理重定向和相对URL
**文件**: `src/core/tools/web-tools.ts` (Line 16-47)

**问题**: 
- 没有处理 HTTP 重定向 (301/302)
- `extractLinks` 中的相对 URL 解析可能失败
- 没有设置超时错误处理

---

### 7. `subagentSystem.runAgent` 没有传播原始选项
**文件**: `src/core/subagent-system.ts` (Line 118-128)

```typescript
async runAgent(agentName: string, task: string, parentModel?: string): Promise<string> {
  // ...
  const agent = new AgentCore({ domain: 'auto', model, stream: false, verbose: false });
```

**问题**: 子代理硬编码了 `stream: false, verbose: false`，导致父代理的 `verbose` 设置无法传递给子代理。

---

### 8. `context-compressor.ts` 的 token 估算过于简化
**文件**: `src/core/context-compressor.ts` (Line 32-36)

```typescript
function estimateTokens(text: string, isJson = false): number {
  return Math.ceil(text.length / (isJson ? 2 : 4));
}
```

**问题**: 对于中文、日文等非拉丁字符，字符数与 token 数的比例完全不同（通常是 1-2 字符/token）。这会导致对于多语言对话，token 估算严重偏低，可能触发意外的上下文压缩。

**建议**: 使用更准确的估算，比如 `tiktoken` 库或根据 Unicode 范围调整系数。

---

### 9. `ToolRegistry.execute` 中的类型检查对数组不准确
**文件**: `src/core/tool-registry.ts` (Line 117-123)

```typescript
function checkType(field: string, value: unknown, schema: ParameterSchema): SchemaError | null {
  if (value === null || value === undefined) return null;
  const actualType = Array.isArray(value) ? 'array' : typeof value;
```

**问题**: 虽然检测了 `array`，但没有进一步验证数组元素的类型与 `schema.items` 的匹配。

---

### 10. `session-history.ts` 的 `clearHistory` 竞争条件
**文件**: `src/core/session-history.ts` (Line 105-123)

**问题**: 如果两个进程同时调用 `clearHistory`，可能出现文件写入竞争，导致历史文件损坏。

---

## 🟡 低优先级 Bug / 改进建议 (Low Priority)

### 11. `code-inspector.ts` 的长函数检测误报
**文件**: `src/core/tools/code-inspector.ts` (Line 200-241)

```typescript
const fnDefPattern = /(?:^|\s)(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>|\w+\s*\([^)]*\)\s*\{)/;
```

**问题**: 这个正则会匹配箭头函数、普通函数，但也会误匹配对象字面量中的方法定义、类中的 getter/setter 等。

---

### 12. `self-heal.ts` 的 deterministic fix 过于简单
**文件**: `src/core/tools/self-heal.ts` (Line 54-69)

**问题**: `deterministicFix` 只处理了 `console-log-leftover` 和 `no-explicit-any`，但许多其他规则也可以有确定性修复（如 `non-null-assertion` → 可选链）。

---

### 13. `MCPManager` 的 `connectStdioServer` 未实现
**文件**: `src/core/mcp-manager.ts` (Line 70-71)

```typescript
private async connectStdioServer(_server: MCPServer): Promise<ToolRegistration[]> {
  return []; // Full impl needs @modelcontextprotocol/sdk
```

**问题**: stdio 类型的 MCP 服务器根本无法使用，但 README 和文档没有说明这个限制。

---

### 14. `model-fallback.ts` 没有处理特定的 API 错误码
**文件**: `src/core/model-fallback.ts` (Line 28-33)

```typescript
const NON_FALLBACK_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  // ...
];
```

**问题**: 对于像 OpenAI 的 `rate_limit_exceeded` 或 `insufficient_quota`，应该立即 fallback，但当前实现可能重试导致更长时间等待。

---

### 15. `domain-router.ts` 的 auto 模式没有区分权重
**文件**: `src/core/domain-router.ts` (Line 10-19)

```typescript
detectDomain(prompt: string): string {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = { data: 0, dev: 0, service: 0 };
  for (const [name, plugin] of Object.entries(DOMAINS)) {
    for (const kw of plugin.keywords) {
      if (lower.includes(kw)) scores[name]++;
    }
  }
```

**问题**: 所有关键词权重相同。像 "data" 这种通用词出现在 dev 语境中（如 "data structure"）时可能会误判。

**建议**: 为关键词添加权重，并考虑词序（如 "data analysis" vs "analysis data"）。

---

## 🐛 潜在的运行时问题

### 16. `abortSignal.timeout` 兼容性问题
**多处代码使用**: `AbortSignal.timeout(15000)`

**问题**: `AbortSignal.timeout()` 是较新的 API（Node.js 16.14+），在旧版本 Node.js 上会抛出 `TypeError`。

**建议**: 添加 polyfill：
```typescript
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}
```

---

### 17. `chalk` v5 在 CommonJS 环境中的潜在问题
**文件**: `package.json` 使用 `"type": "module"`

**问题**: chalk v5 是纯 ESM，虽然项目已设置 `"type": "module"`，但如果用户尝试通过某些工具（如 Jest 的某些版本）以 CommonJS 方式运行，可能会报错。

---

### 18. `duckdb` 依赖未使用
**文件**: `package.json` (Line 33)

```json
"dependencies": {
  "duckdb": "^1.1.3",
```

**问题**: 搜索整个代码库没有发现 `duckdb` 的实际使用。这是一个沉重的依赖（需要本地编译），如果不需要应该移除。

---

### 19. `fast-glob` 导入但可能未使用
**文件**: `package.json` (Line 37)

**问题**: 搜索发现 `fast-glob` 被声明为依赖，但在核心代码中没有找到实际使用。`collectFiles` 函数使用的是原生 `fs.readdirSync`。

---

### 20. `readline` 作为依赖声明是多余的
**文件**: `package.json` (Line 32)

```json
"readline": "^1.3.0",
```

**问题**: `readline` 是 Node.js 内置模块，不需要作为 npm 依赖声明。而且 npm 上的 `readline` 包是一个不相关的旧包，可能会造成混淆。

---

## 🔧 构建/类型问题

### 21. TypeScript 严格模式下的潜在类型错误
**多处**: 未完全检查

**问题**: `tsconfig.json` 未启用 `strict: true`，可能导致某些边界情况下的类型不安全。

**建议**: 启用严格模式：
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

---

### 22. `tool-registry.ts` 中的 `any` 类型使用
**文件**: `src/core/tool-registry.ts`

**问题**: 某些类型断言使用了 `as` 类型转换而不是适当的类型守卫，可能在边界情况下失败。

---

## 📊 总结统计

| 优先级 | 数量 |
|--------|------|
| 🔴 严重 | 3 |
| 🟠 中等 | 10 |
| 🟡 低/建议 | 9 |

### 最严重的前 5 个问题:
1. **bashTool safeMode 不完整** - 安全风险
2. **Grep 命令注入** - 安全风险
3. **AbortSignal.timeout 兼容性** - 运行时崩溃
4. **token 估算不准确** - 多语言支持问题
5. **MCP stdio 未实现** - 功能缺失

---

## 💡 建议的优先级修复顺序

1. 🔴 **立即修复**: bashTool 安全检测、Grep 参数转义
2. 🟠 **本周内**: AbortSignal 兼容层、token 估算改进
3. 🟡 **下个版本**: MCP stdio 实现、子代理选项传播
4. 🟢 **文档更新**: 说明 MCP 限制、safeMode 行为
