# 代码审查报告 — universal-agent 项目

> **生成时间**: 2026-04-04
> **健康评分**: 54 / 100 🟠（需改进）

---

## 总体概况

| 指标 | 值 |
|------|-----|
| 扫描文件数 | 93 |
| 总问题数 | **1349** |
| 🔴 Critical | 6 |
| 🟠 Error | 168 |
| 🟡 Warning | 656 |
| 🔵 Info | 519 |

---

## 🔴 Critical — 安全漏洞（必须立即修复）

### 1. eval() 使用 — 任意代码执行风险 (CWE-94)

- **文件**: `src/core/tools/code/code-inspector.ts` L157–158
- **风险**: 攻击者可通过构造输入来执行任意代码
- **修复方案**: 移除 `eval()`，改用 `JSON.parse()` 处理数据

```typescript
// ❌ 危险
const result = eval(userInput);

// ✅ 安全
const result = JSON.parse(userInput);
```

---

### 2. 硬编码凭据 (CWE-798)

| 文件 | 位置 | 内容 |
|------|------|------|
| `src/core/tools/productivity/database-query.ts` | L185, L244 | 数据库密码 |
| `src/tests/fs-tools.test.ts` | L61, L93 | API 密钥测试数据 |

- **风险**: 凭据提交到版本控制，存在泄露风险
- **修复方案**: 使用环境变量或密钥管理器替代硬编码值

```typescript
// ❌ 危险
const password = "hardcoded_password_123";

// ✅ 安全
const password = process.env.DB_PASSWORD;
if (!password) throw new Error("DB_PASSWORD is not set");
```

---

## 🟠 Error — 高优先级问题（168 个）

### 1. 路径遍历漏洞 (CWE-22) — 75+ 处

几乎所有文件系统操作均未做路径校验，存在越权访问风险。

```typescript
// ❌ 危险
const content = readFileSync(filePath, 'utf-8');

// ✅ 安全
const safe = resolve(ALLOWED_DIR, fileName);
if (!safe.startsWith(ALLOWED_DIR)) {
  throw new Error("Path traversal detected");
}
const content = readFileSync(safe, 'utf-8');
```

**受影响文件（主要）**:

| 文件 | 问题行 |
|------|--------|
| `src/cli/configure.ts` | L17, L35 |
| `src/cli/debug-check.ts` | L177, L230 |
| `src/cli/index.ts` | L38, L218, L254 |
| `src/core/hooks.ts` | L183, L201 |
| `src/core/mcp-manager.ts` | L212, L344 |
| `src/core/memory/memory-store.ts` | L128, L145 |
| 其他 30+ 文件 | — |

> **建议**: 提取公共 `safeReadFile(base, path)` 工具函数，统一处理路径校验逻辑。

---

## 🟡 Warning — 中优先级问题（656 个）

### 1. 同步 I/O 阻塞事件循环 — 200+ 处

大量使用 `readFileSync`、`writeFileSync`、`execSync`，会阻塞 Node.js 事件循环，导致 CLI 响应迟缓。

```typescript
// ❌ 同步阻塞
const raw = execSync(cmd, { encoding: 'utf-8' });

// ✅ 异步非阻塞
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);
const { stdout: raw } = await execAsync(cmd);
```

**主要受影响文件**:

- `src/core/tools/productivity/database-query.ts` — 数据库查询全为同步
- `src/core/tools/code/ai-reviewer.ts` — Git 操作
- `src/core/tools/code/business-defect-detector.ts`
- `src/core/tools/productivity/github-pr-tool.ts`
- `src/core/agent.ts` L406

---

### 2. console.log 残留 — 400+ 处

调试输出未通过正式 logger，无法控制日志级别和格式化输出。

```typescript
// ❌ 调试残留
console.log(chalk.green('✓ Saved'));

// ✅ 正式 logger
logger.info('File saved successfully');
```

**主要文件**:

| 文件 | 约占数量 |
|------|----------|
| `src/cli/index.ts` | 180+ 处 |
| `src/cli/ui-enhanced.ts` | 82 处 |
| `src/cli/debug-check.ts` | 46 处 |
| `src/cli/configure.ts` | 35 处 |

---

### 3. 弱加密算法 SHA1 (CWE-327) — 3 处

SHA1 已不再安全，不应用于内容寻址或完整性校验。

| 文件 | 位置 |
|------|------|
| `src/core/memory/embedding.ts` | L71 |
| `src/core/memory/memory-store.ts` | L92 |
| `src/core/tools/productivity/ws-mcp-server.ts` | L117 |

```typescript
// ❌ 弱加密
return createHash('sha1').update(text).digest('hex');

// ✅ 安全
return createHash('sha256').update(text).digest('hex');
```

---

### 4. 非空断言操作符 `!` 滥用 — 30+ 处

强制断言可能导致运行时 `TypeError`，应改为显式判断。

```typescript
// ❌ 强制断言
this.proc.stdout!.setEncoding('utf-8');

// ✅ 显式检查
if (this.proc.stdout) {
  this.proc.stdout.setEncoding('utf-8');
} else {
  throw new Error("Process stdout is not available");
}
```

---

## 🔵 Info — 代码质量建议（519 个）

### 1. 魔法数字 — 400+ 处

大量未命名的裸数字，降低代码可读性和可维护性。

**建议提取为具名常量**:

| 魔法数字 | 含义 | 建议常量名 |
|----------|------|------------|
| `128000` | 上下文长度 | `DEFAULT_CONTEXT_LENGTH` |
| `8192` | 最大 Token 数 | `DEFAULT_MAX_TOKENS` |
| `15000` | 默认超时 (ms) | `DEFAULT_TIMEOUT_MS` |
| `30000` | 长操作超时 (ms) | `LONG_TIMEOUT_MS` |
| `5432` | PostgreSQL 端口 | `POSTGRESQL_DEFAULT_PORT` |
| `3306` | MySQL 端口 | `MYSQL_DEFAULT_PORT` |

---

### 2. 函数过长 — 15+ 处

超长函数难以测试和维护，建议按职责拆分。

| 文件 | 函数 / 位置 | 行数 |
|------|-------------|------|
| `src/core/agent.ts` | 主循环 while 块 | ~561 行 |
| `src/cli/index.ts` | 主入口函数 | ~144 行 |
| `src/core/tools/code/spec-generator.ts` | 多个函数 | 60+ 行 |

> **建议**: `agent.ts` 的 while 循环可拆分为 `handleToolCall()`、`handleLLMResponse()`、`runCompactionIfNeeded()` 等独立函数。

---

## 修复优先级与工作量

| 优先级 | 类别 | 问题数 | 预估工时 |
|--------|------|--------|----------|
| P0 | 移除 `eval()` | 1 | 1h |
| P0 | 外部化硬编码凭据 | 4 | 2h |
| P0 | 路径遍历防护 | 75+ | 2–3d |
| P1 | 同步 I/O 改异步 | 200+ | 3–5d |
| P1 | SHA1 升级 SHA-256 | 3 | 2h |
| P1 | 非空断言修复 | 30+ | 1d |
| P2 | 提取魔法数字常量 | 400+ | 2–3d |
| P2 | 拆分长函数 | 15+ | 2–3d |
| P2 | 统一日志系统 | 400+ | 3–5d |

---

## 受影响模块分布

| 模块 | 文件数 | 问题占比 |
|------|--------|----------|
| CLI 模块 (`src/cli/`) | ~10 | 40% |
| Core 工具 (`src/core/tools/`) | ~15 | 35% |
| 测试文件 (`src/tests/`) | ~8 | 10% |
| 其他 | ~60 | 15% |
