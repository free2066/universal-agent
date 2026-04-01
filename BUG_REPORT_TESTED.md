# Universal Agent CLI - 实际测试 Bug 报告

> 📅 测试日期: 2026-04-01  
> 📁 项目路径: `/Users/guozhongming/universal-agent`  
> 📝 版本: 0.1.0  
> 🖥️ Node.js: v25.8.2

---

## 🔴 实际确认的 Bug

### 1. 没有 API Key 时程序崩溃
**严重性**: 🔴 高

```bash
$ ./dist/cli/index.js run "hello"
OpenAIError: The OPENAI_API_KEY environment variable is missing...
    at new OpenAI
```

**预期行为**: 应该优雅地提示用户设置 API Key，而不是崩溃

---

### 2. 无效的 domain 名称不被验证
**严重性**: 🟠 中

```bash
$ ./dist/cli/index.js run -d invalid_domain "hello"
Session start: domain=invalid_domain, model=gpt-4o  # 没有报错！
```

**预期行为**: 应该报错并列出有效 domain

---

### 3. 无效的模型名称不被验证
**严重性**: 🟠 中

```bash
$ ./dist/cli/index.js run -m invalid_model "hello"  
Session start: domain=dev, model=invalid_model  # 没有报错！
```

**预期行为**: 应该报错并列出可用模型

---

### 4. 中文 token 估算不准确
**严重性**: 🟠 中

```javascript
Chinese text length: 32 chars
Estimated tokens: 20
Ratio: 1.6 chars/token  # 应该是约 2-3 chars/token
```

**影响**: 中文对话时上下文压缩可能过于激进

---

### 5. 设置无效的 model pointer 不报错且污染配置
**严重性**: 🟠 中

```javascript
manager.setPointer('invalid_pointer', 'gpt-4o');  // 成功执行，没有报错
// 之后 getPointers() 返回:
{ main: 'gpt-4o', task: 'gpt-4o-mini', ..., invalid_pointer: 'gpt-4o' }
```

**影响**: 无效指针被永久保存到配置中

---

### 6. 获取不存在模型时崩溃
**严重性**: 🟠 中

```javascript
manager.setPointer('main', 'non-existent-model-12345');
manager.getClient('main');
// Error: Cannot read properties of undefined (reading 'startsWith')
```

**预期行为**: 应该返回友好的错误消息

---

### 7. Read 工具读取目录时返回原始错误
**严重性**: 🟡 低

```bash
$ Read directory: Error reading file: EISDIR: illegal operation on a directory, read
```

**预期行为**: 返回友好的错误提示如 "Error: Path is a directory"

---

### 8. Grep 工具无效正则不报错
**严重性**: 🟡 低

```javascript
grepTool.handler({ pattern: '[invalid(', path: 'src' })
// 返回: "No matches found for pattern: [invalid("
```

**预期行为**: 应该提示用户正则表达式语法错误

---

### 9. MCP init 在目录不存在时崩溃
**严重性**: 🟡 低

```javascript
MCPManager.initConfig('/tmp/nonexistent/dir');
// Error: ENOENT: no such file or directory
```

**预期行为**: 自动创建目录或提示用户创建

---

### 10. Self Heal 单文件模式报告 "File not found"
**严重性**: 🟡 低

```bash
$ Self Heal on /tmp/test.ts
// 报告: "File not found" 即使文件存在
```

**原因**: 可能把文件路径当作目录处理

---

## ✅ 确认正常工作的功能

### 1. Bash 工具安全模式 ✅
所有危险命令都被正确拦截：
- `rm -rf /home/user` ✅ 被阻止
- `curl ... | bash` ✅ 被阻止
- `sudo rm -rf /etc` ✅ 被阻止
- `> /dev/sda1` ✅ 被阻止
- Fork bomb ✅ 被阻止

### 2. Grep 工具命令注入防护 ✅
路径中的单引号被正确转义，命令注入被阻止

### 3. 工具参数验证 ✅
- 参数类型错误 ✅ 被捕获
- 缺少必需参数 ✅ 被捕获
- 无效工具名称 ✅ 被捕获

### 4. Inspect 代码检查 ✅
```bash
$ ./dist/cli/index.js inspect src/core/tools/fs-tools.ts
Files scanned : 1
Health score  : 77/100 🟡 Good
```

### 5. Purify 自动修复 ✅
```bash
$ ./dist/cli/index.js purify -d src/core/tools/fs-tools.ts
Found 11 findings (score: 77/100)
```

### 6. WebFetch 工具 ✅
```bash
$ WebFetch https://example.com  # 成功获取内容
```

### 7. 子代理系统 ✅
```bash
$ ./dist/cli/index.js agents
👤 Available Subagents:
  @run-agent-reviewer    ...
  @run-agent-architect   ...
```

### 8. MCP 管理 ✅
```bash
$ ./dist/cli/index.js mcp init   # 成功创建 .mcp.json
$ ./dist/cli/index.js mcp list   # 成功列出服务器
```

### 9. Domain 列表 ✅
```bash
$ ./dist/cli/index.js domains
🌐 Available Domains:
  data      Data analysis...
  dev       Code review...
  service   Customer service...
```

---

## 📊 测试统计

| 类别 | 数量 |
|------|------|
| 🔴 严重 Bug | 1 |
| 🟠 中等 Bug | 5 |
| 🟡 低优先级 Bug | 4 |
| ✅ 正常工作 | 15 |

---

## ✅ 测试覆盖情况

### 已测试的核心功能
- [x] CLI 命令解析 (--help, domains, agents, models, mcp, init)
- [x] 构建流程 (npm install, npm run build)
- [x] 文件工具 (Read, Write, Edit, LS, Grep, Bash)
- [x] Web 工具 (WebFetch, WebSearch)
- [x] 代码检查 (InspectCode)
- [x] 自动修复 (SelfHeal)
- [x] 模型管理 (ModelManager, 回退链)
- [x] 工具注册和验证 (ToolRegistry)
- [x] 上下文压缩 (ContextCompressor, ContextEditor)
- [x] 工具选择器 (ToolSelector)
- [x] 子代理系统 (SubagentSystem)
- [x] MCP 管理 (MCPManager)
- [x] 会话历史 (SessionHistory)
- [x] 日志系统 (Logger)
- [x] 工具重试 (ToolRetry)
- [x] Domain 路由 (DomainRouter)

### 未测试的功能
- [ ] 交互式 chat 模式 (需要 API key)
- [ ] run 命令完整执行 (需要 API key)
- [ ] 子代理实际运行 (需要 API key)
- [ ] MCP 服务器连接 (需要外部服务)
- [ ] 配置向导 (uagent config)

---

## 🎯 建议修复优先级

### 立即修复 (P0)
1. **API Key 缺失时的错误处理** - 添加 try-catch 和友好提示

### 本周修复 (P1)
2. **Domain/模型名称验证** - 添加有效值检查
3. **获取不存在模型时的错误处理** - 防止 undefined 访问
4. **中文 token 估算** - 使用 unicode 范围调整系数
5. **无效 model pointer 验证** - 防止污染配置

### 可选修复 (P2)
6. **读取目录时的友好错误**
7. **Grep 无效正则提示**
8. **MCP init 目录创建**
9. **Self Heal 单文件模式**

---

## 📝 测试命令记录

```bash
# 构建和基本测试
npm install       # ✅ 成功
npm run build     # ✅ 成功

# 命令测试
./dist/cli/index.js --help      # ✅
./dist/cli/index.js domains     # ✅
./dist/cli/index.js agents      # ✅
./dist/cli/index.js models list # ✅
./dist/cli/index.js mcp init    # ✅
./dist/cli/index.js mcp list    # ✅
./dist/cli/index.js init        # ✅
./dist/cli/index.js inspect -s info src/core/tools/fs-tools.ts  # ✅
./dist/cli/index.js purify -d -s info src/core/tools/fs-tools.ts # ✅

# 运行时测试 (需要 API Key)
./dist/cli/index.js run "hello"              # ❌ 崩溃
./dist/cli/index.js run -d invalid "hello"   # ❌ 不验证
./dist/cli/index.js run -m invalid "hello"   # ❌ 不验证
```
