# 🔍 Code Review Report — universal-agent

> **Updated:** 2026-04-04（反映 commit `c804b6b` 之后的最新状态）  
> **Scanner:** Manual static analysis + git diff analysis（92 source files）  
> **Health Score:** **88/100** ↑（初次 54 → 修复后 88）

---

## 📊 Executive Summary

经过三轮集中修复（commit `9f63a92` / `03d81b2` / `c804b6b`），项目的安全性和性能得到了大幅提升。

| 问题类别 | 修复前 | 修复后 | 状态 |
|---------|--------|--------|------|
| 弱哈希（SHA-1） | 2 处 | 0 处 | ✅ 已修复 |
| 不安全随机数 | 1 处 | 0 处 | ✅ 已修复 |
| 同步 I/O（关键路径） | 8 处 | 0 处 | ✅ 已修复 |
| 路径遍历（CWE-22） | ~30 处 | 2 处（低风险） | ✅ 已修复 |
| 魔法数字 | 20+ 处 | 5 处（边界） | ✅ 已修复 |
| 429 无重试 | 有 | 已修复（3次指数退避） | ✅ 已修复 |
| 上下文爆满触发 | 80K tokens | 60K tokens | ✅ 已调优 |
| 命令注入（CWE-78） | 3 处 | 3 处 | 🔴 **未修复** |
| 路径遍历（内部子系统） | — | 4 个文件 | 🟠 **遗留** |

---

## 🔴 Critical Issues（待修复）

### C1. 命令注入 `database-query.ts`（CWE-78）

**文件：** `src/core/tools/productivity/database-query.ts`（L156、L197–L204、L252–L262）

三个数据库查询函数（`runSqlite` / `runPostgres` / `runMysql`）通过 `sh -c` 执行拼接的 Shell 命令字符串。用户提供的 SQL 和连接字符串经过简单单引号转义后直接插入命令。

```typescript
// ❌ 当前危险写法
const cmd = `sqlite3 -json '${file}' '${limitedSql}'`;
const { stdout } = await execFileAsync('sh', ['-c', cmd], { ... });

// ❌ PostgreSQL — 密码放入 env 是正确的，但 SQL 仍通过 sh -c 拼接
const cmd = `PGPASSWORD='${pass}' psql '${connStr}' --command '${escapedSql}'`;
```

**风险：** 精心构造的 SQL 或密码（包含 `'\''` 序列）可以突破单引号转义执行任意 Shell 命令。

**修复方案 — 使用 `execFile` 参数数组：**

```typescript
// ✅ 安全的 SQLite 执行
const { stdout } = await execFileAsync('sqlite3', [
  '-json', file, limitedSql
], { encoding: 'utf-8', timeout: DB_DEFAULT_TIMEOUT_MS });

// ✅ 安全的 PostgreSQL 执行（密码通过 env var，SQL 通过参数）
const { stdout } = await execFileAsync('psql', [
  connStr, '--tuples-only', '--csv', '--command', limitedSql
], {
  encoding: 'utf-8',
  timeout: DB_DEFAULT_TIMEOUT_MS,
  env: { ...process.env as Record<string, string>, PGPASSWORD: pass },
});

// ✅ 安全的 MySQL 执行
const { stdout } = await execFileAsync('mysql', [
  '--batch', '--skip-column-names',
  `-h${host}`, `-P${port}`, `-u${user}`,
  `--password=${pass}`, dbName,
  '-e', limitedSql,
], { encoding: 'utf-8', timeout: DB_DEFAULT_TIMEOUT_MS });
```

---

### C2. `execSync` 字符串插值 `code-execute.ts`（CWE-78）

**文件：** `src/domains/dev/tools/code-execute.ts`（L46、L53）

```typescript
// ❌ 当前危险写法
output = execSync(`python3 -c '${escaped}'`, { ... });
output = execSync(`node -e \`${escaped}\``, { ... });
```

**修复方案：**

```typescript
// ✅ 通过标准输入传入代码（最安全）
import { spawnSync } from 'child_process';
const r = spawnSync('python3', ['-c', escaped], {
  input: '',
  encoding: 'utf-8',
  timeout: CODE_EXECUTE_TIMEOUT_MS,
});
```

---

## 🟠 Error Issues（遗留）

### E1. 内部子系统未使用 `path-security.ts`

`src/utils/path-security.ts` 已经存在（`safeResolve`、`sanitizeName`、`isPathWithinBase`），但以下文件在构建内部路径时仍未使用：

| 文件 | 风险点 | 推荐修复 |
|------|--------|---------|
| `core/context/context-loader.ts` | `join(dir, 'AGENTS.md')` — `dir` 来自路径链循环 | `safeResolve` 验证每个 dir |
| `core/memory/memory-store.ts` | `join(projDir, memoryId + '.json')` | `sanitizeName(memoryId)` 后再 join |
| `core/tools/code/spec-generator.ts` | `join(specsDir, specName + '.md')` | `sanitizeName(specName)` 后再 join |
| `core/teammate-manager.ts` | `join(tasksDir, taskId + '.json')` | `sanitizeName(taskId)` 后再 join |

**风险等级：** 中等（这些路径不直接接受用户命令行输入，但如果 LLM 构造了恶意的 ID，仍有风险）

```typescript
// ✅ 统一修复模式
import { sanitizeName, safeResolve } from '../../utils/path-security.js';

const safeId = sanitizeName(memoryId, 'memory ID');
const filePath = safeResolve(safeId + '.json', this.storageDir);
```

---

## 🟡 Warning Issues（待改善）

### W1. `console.*` 直接调用 — 425 处

项目已有 `src/cli/log.ts` 统一 logger，但全局仍大量使用 `console.log / console.error / console.warn`，导致：
- CI/CD 无法按级别过滤输出
- 无法添加时间戳或上下文信息

**高频文件：**

| 文件 | `console.*` 调用数 |
|------|-----------------|
| `src/cli/index.ts` | 80+ |
| `src/core/agent.ts` | 20+ |
| `src/core/tools/*` | 50+ |

**建议：** 在 `cli/index.ts` 入口处注入 log level，用 `createLogger` 替换模块中的直接 `console.*`。

### W2. 错误处理 `catch` 块模式不统一

多处 `catch (err)` 通过类型断言访问属性，存在运行时风险：

```typescript
// ❌ 现有写法（多处）
const e = err as { stderr?: string; message?: string };
throw new Error(`Failed: ${e.stderr ?? e.message ?? String(err)}`);
```

**建议：添加全局 `errorDetail` helper：**

```typescript
// src/utils/error.ts
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    return String((err as { stderr: unknown }).stderr);
  }
  return String(err);
}
```

### W3. 大函数未拆分

| 函数 | 位置 | 行数 | 建议 |
|------|------|------|------|
| Agent 主循环 `runStream` | `core/agent.ts:548–990` | ~440 行 | 拆分为 `_executeTurn()` / `_executeTools()` / `_handleResponse()` |
| `coordinatorTool.handler` | `core/tools/agents/coordinator-tool.ts` | ~200 行 | 拆分子任务分发逻辑 |

---

## 🔵 Info Issues

### I1. 测试夹具中的假凭证标注不清晰

**文件：** `tests/fs-tools.test.ts`（L61、L93）

```typescript
// ❌ 容易被误判为真实凭证
const content = `const apiKey = "sk-abc123..."`;

// ✅ 推荐加清晰标注
const FAKE_API_KEY_FOR_TEST = 'sk-TEST_NOT_REAL_xxxxxxxxxxxx'; // pragma: allowlist secret
```

### I2. 少量剩余魔法数字

| 值 | 位置 | 建议常量名 |
|----|------|----------|
| `50000` | `worktree-tools.ts` run() 输出截断 | `WORKTREE_RUN_MAX_OUTPUT_CHARS` |
| `300` | `agent.ts` verbose 输出预览截断 | `TOOL_RESULT_PREVIEW_CHARS` |
| `120` | `agent.ts` 工具参数截断 | `TOOL_ARGS_PREVIEW_CHARS` |
| `128` | `path-security.ts` 名称长度限制 | `NAME_MAX_LENGTH` |
| `5` | `context-editor.ts` keep 数量 | `CTX_EDITOR_DEFAULT_KEEP`（已有注释，可提取） |

---

## ✅ 已完成的修复（本轮修复清单）

### Commit `9f63a92` — 安全性 + 性能基础修复

| 问题 | 修复 |
|------|------|
| `embedding.ts` SHA-1 弱哈希 | → SHA-256（`createHash('sha256')`） |
| `memory-store.ts` SHA-1 + `Math.random()` ID | → SHA-256 + `crypto.randomUUID()` |
| `database-query.ts` 3 个函数 `execSync` 阻塞 | → `execFileAsync`（全异步） |
| `hooks.ts` `runShellHook` `execSync` | → `execFileAsync` |
| 多处魔法数字 | → 具名常量（`DB_DEFAULT_TIMEOUT_MS`、`DEFAULT_MAX_ITERATIONS` 等） |
| `agent.ts` 超长主循环 | → 部分拆分，提取常量 |

### Commit `03d81b2` — CWE-22 路径遍历加固

| 问题 | 修复 |
|------|------|
| 新增 `src/utils/path-security.ts` | `safeResolve()` / `sanitizeName()` / `isPathWithinBase()` |
| `cli/index.ts` `--context <id>` 参数 | `sanitizeName` + `safeResolve` 防止 `../../etc/passwd` |
| `cli/index.ts` `--save-context <name>` 参数 | `sanitizeName` + `safeResolve` 保护写入路径 |
| `worktree-tools.ts` `validateName()` | 委托 `sanitizeName()`，`bindTaskToWorktree` 增加整数校验 |

### Commit `c804b6b` — 上下文管理 + QPS 优化

| 问题 | 修复 |
|------|------|
| 429 交互模式直接 fail-fast | → 3 次指数退避（5s→10s→20s ±25% jitter） |
| ctx-editor 触发 80K tokens（太晚） | → 60K tokens（可 `AGENT_CTX_TRIGGER` 覆盖） |
| 工具结果保留 3 个（不够用） | → 5 个，减少 LLM 重复 Read/Grep |
| microcompact 清理阈值 60min | → 15min（`AGENT_MICROCOMPACT_AGE_MS`），字符阈值 500→200 |
| while 循环无 LLM 调用间隔 | → 500ms 最小间隔（`AGENT_MIN_ROUND_INTERVAL_MS`） |
| 工具调用全串行 | → Read/LS/Grep 类 `Promise.all` 并行执行（最多 5 个） |

---

## 📈 修复进度

| 时间 | Health Score | 剩余关键问题 | 说明 |
|------|-------------|------------|------|
| 2026-04-04 初次扫描 | 54/100 | 1328 | 首次全量扫描 |
| commit `9f63a92` 后 | 72/100 | ~600 | 弱哈希 + 阻塞 I/O 修复 |
| commit `03d81b2` 后 | 81/100 | ~172 | 路径遍历加固 |
| commit `c804b6b` 后 | **88/100** | **~80** | QPS + 上下文优化 |
| 目标（修复 C1/C2） | **95/100** | <20 | 修复命令注入后可达到 |

---

## 🛠️ 下一步优先级

### P0：安全（1–2 天，建议立即修复）

- [ ] **C1** — `database-query.ts`：将 `sh -c` + 字符串拼接改为 `execFile` 参数数组
- [ ] **C2** — `code-execute.ts`：将 `execSync` 字符串插值改为 `spawnSync` stdin 传入

### P1：路径安全完整性（0.5 天）

- [ ] **E1** — 对 `memory-store.ts`、`spec-generator.ts`、`teammate-manager.ts` 中的内部路径应用 `sanitizeName` + `safeResolve`

### P2：代码质量（3–5 天，下个迭代）

- [ ] **W1** — 统一 logger：全局替换 `console.*` 为 `createLogger()`
- [ ] **W2** — 提取 `errorDetail()` helper 统一错误处理
- [ ] **W3** — 拆分 `agent.ts` `runStream`（440 行）为 3 个子函数
- [ ] **I2** — 提取剩余 5 处魔法数字到具名常量

---

*报告最后更新：2026-04-04（对应 HEAD commit `c804b6b`）。如需重新扫描，运行 `uagent inspect src --severity warning`。*
