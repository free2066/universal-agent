# universal-agent TODO

## 未来计划

### [ ] Eval 自动化评测体系（约 v1.5+）

**背景**：参考 [Evals are the new PRD](https://kstack.corp.kuaishou.com/article/15398)，当前处于 Vibes 阶段（无结构化测量），功能趋于稳定后引入评测体系。

**分阶段目标**：

1. **Test state**：建立基础评测用例集
   - taskRouter 路由准确性：给 N 个典型 prompt，验证路由到预期模型
   - fallback 链切换：模拟 API 超时，验证按 models.json 顺序切换
   - `/remember` 命令：验证写入内容、时间戳格式正确性
   - autoCompact 触发：构造 >80% 上下文，验证自动压缩

2. **CI/CD**：将评测集成到 CI，每次发版自动触发，不达标阻断发布

3. **Flywheel**：采集生产数据（用户 prompt / 路由结果），自动补充评测用例

**优先使用 GSB 对比评测**（Better/Same/Worse），无需 ground truth，成本低。

---

### [ ] LLM Council 多模型并行分析择优（Phase 1）

**背景**：参考 Jarvis 文档的 LLM Council 设计理念，让多个模型并行分析同一问题，通过评分机制择优输出，提高复杂任务的准确率。

**核心机制（三阶段）**：
1. **并行生成**：同时向 2-5 个模型发送相同 prompt
2. **交叉评分**：各模型相互评分（correctness, completeness, code_quality）
3. **择优决策**：highest_score / majority_vote / chairman_decision

**技术实现**：

#### 1. Council 配置系统

新建文件：`src/config/councilConfig.ts`

```typescript
interface CouncilConfig {
  enabled: boolean
  models: CouncilMember[]
  scoringCriteria: ScoringCriteria
  selectionStrategy: 'highest_score' | 'majority_vote' | 'chairman_decision'
  chairman?: string  // 主席模型（用于最终决策）
  timeoutMs: number
  parallelLimit: number  // 最大并行数
}

interface CouncilMember {
  modelId: string
  role: 'reviewer' | 'generator' | 'chairman'
  weight: number  // 评分权重
}

interface ScoringCriteria {
  dimensions: ScoreDimension[]
  maxScore: number
  minScore: number
}

interface ScoreDimension {
  name: string  // 如：correctness, completeness, code_quality
  description: string
  weight: number
}
```

#### 2. Council 执行器

新建文件：`src/tools/CouncilTool/CouncilExecutor.ts`

```typescript
export class CouncilExecutor {
  constructor(private config: CouncilConfig) {}

  // 阶段1: 并行生成
  async parallelGenerate(prompt: string, tools: Tools): Promise<CouncilResponse[]> {
    const members = this.config.models.filter(m => m.role !== 'chairman')
    const requests = members.map(m => 
      this.callModel(m.modelId, prompt, tools)
    )
    return Promise.all(requests)
  }

  // 阶段2: 交叉评分
  async crossEvaluate(responses: CouncilResponse[]): Promise<ScoreMatrix> {
    const matrix: ScoreMatrix = {}
    
    for (const reviewer of this.config.models) {
      for (const response of responses) {
        if (reviewer.modelId !== response.modelId) {
          const score = await this.scoreResponse(reviewer, response)
          matrix[`${reviewer.modelId}->${response.modelId}`] = score
        }
      }
    }
    
    return matrix
  }

  // 阶段3: 择优决策
  selectBest(matrix: ScoreMatrix, responses: CouncilResponse[]): CouncilResponse {
    switch (this.config.selectionStrategy) {
      case 'highest_score':
        return this.selectByHighestScore(matrix, responses)
      case 'majority_vote':
        return this.selectByMajorityVote(matrix, responses)
      case 'chairman_decision':
        return this.selectByChairman(matrix, responses)
    }
  }
}
```

#### 3. Council 工具定义

新建文件：`src/tools/CouncilTool/CouncilTool.ts`

```typescript
export const COUNCIL_TOOL = {
  name: 'Council',
  description: 'Run multiple LLMs in parallel and select the best response',
  inputSchema: z.object({
    prompt: z.string().describe('The prompt to send to all council members'),
    models: z.array(z.string()).optional().describe('Override default council models'),
    strategy: z.enum(['highest_score', 'majority_vote', 'chairman_decision']).optional(),
    timeout: z.number().optional().describe('Timeout in milliseconds'),
  }),
  
  async call(input, toolUseContext, canUseTool) {
    const config = loadCouncilConfig()
    const executor = new CouncilExecutor(config)
    
    // 阶段1: 并行生成
    const responses = await executor.parallelGenerate(input.prompt, tools)
    
    // 阶段2: 交叉评分
    const scores = await executor.crossEvaluate(responses)
    
    // 阶段3: 择优
    const best = executor.selectBest(scores, responses)
    
    return {
      status: 'completed',
      selectedModel: best.modelId,
      content: best.content,
      allResponses: responses,
      scoreMatrix: scores,
    }
  }
}
```

#### 4. 配置文件示例

新建文件：`~/.uagent/council.json`

```json
{
  "enabled": true,
  "models": [
    {"modelId": "gemini-2.5-flash", "role": "generator", "weight": 1.0},
    {"modelId": "claude-sonnet-4-20250514", "role": "generator", "weight": 1.0},
    {"modelId": "gpt-4.1", "role": "generator", "weight": 1.0},
    {"modelId": "glm-5", "role": "chairman", "weight": 1.5}
  ],
  "scoringCriteria": {
    "dimensions": [
      {"name": "correctness", "description": "代码逻辑正确性", "weight": 0.4},
      {"name": "completeness", "description": "是否完整解决问题", "weight": 0.3},
      {"name": "code_quality", "description": "代码风格和可维护性", "weight": 0.3}
    ],
    "maxScore": 10,
    "minScore": 1
  },
  "selectionStrategy": "chairman_decision",
  "timeoutMs": 120000,
  "parallelLimit": 3
}
```

#### 5. CLI 使用示例

```bash
# 启用 Council 模式
uagent --council

# 指定参与模型
uagent --council-models gemini-2.5-flash,claude-sonnet-4,gpt-4.1

# 使用主席决策模式
uagent --council-strategy chairman --council-chairman glm-5
```

**实现清单**：
- [ ] `src/config/councilConfig.ts` - Council 配置系统
- [ ] `src/tools/CouncilTool/CouncilExecutor.ts` - 执行器
- [ ] `src/tools/CouncilTool/CouncilTool.ts` - 工具定义
- [ ] 评分 Prompt 工程
- [ ] CLI 参数支持 `--council`
- [ ] 单元测试

**预计工时**：14 小时（约 2 天）

---

### [ ] Agent Gateway 统一调度入口（Phase 2）

**背景**：增强 universal-agent 作为统一 Agent 网关的能力，支持远程部署和 A2A 通信，无需依赖 CLI。

**架构设计**：

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Gateway 架构                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              API Gateway Layer                       │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐  │   │
│  │  │ REST API │  │ gRPC    │  │ WebSocket (A2A)    │  │   │
│  │  └────┬────┘  └────┬────┘  └─────────┬───────────┘  │   │
│  └───────┼────────────┼─────────────────┼──────────────┘   │
│          │            │                 │                   │
│  ┌───────▼────────────▼─────────────────▼──────────────┐   │
│  │              Agent Router                             │   │
│  │  ┌─────────────────────────────────────────────────┐ │   │
│  │  │  request → analyze → route → execute → respond  │ │   │
│  │  └─────────────────────────────────────────────────┘ │   │
│  └───────────────────────┬───────────────────────────────┘   │
│                          │                                  │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │              Agent Pool                               │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────────┐ │  │
│  │  │CodeGen │ │Explore │ │ Review │ │ Council (新增) │ │  │
│  │  │ Agent  │ │ Agent  │ │ Agent  │ │    Agent       │ │  │
│  │  └────────┘ └────────┘ └────────┘ └────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**技术实现**：

#### 1. Agent Gateway 核心服务

新建文件：`src/services/gateway/AgentGateway.ts`

```typescript
interface GatewayRequest {
  type: 'chat' | 'task' | 'review' | 'council'
  prompt: string
  context?: {
    cwd?: string
    files?: string[]
    agentType?: string
  }
  options?: {
    model?: string
    timeout?: number
    background?: boolean
  }
}

interface GatewayResponse {
  status: 'success' | 'error' | 'timeout'
  result: AgentResult
  metadata: {
    agentId: string
    model: string
    durationMs: number
    tokenUsage: number
  }
}

export class AgentGateway {
  private agentPool: Map<string, AgentWorker> = new Map()
  private requestQueue: PriorityQueue<GatewayRequest>
  
  async handleRequest(request: GatewayRequest): Promise<GatewayResponse> {
    // 1. 分析请求类型
    const route = this.analyzeRequest(request)
    
    // 2. 选择 Agent
    const agent = this.selectAgent(route)
    
    // 3. 执行并返回
    const result = await this.executeAgent(agent, request)
    
    return {
      status: result.success ? 'success' : 'error',
      result,
      metadata: {
        agentId: agent.id,
        model: agent.model,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      }
    }
  }
  
  private analyzeRequest(request: GatewayRequest): AgentRoute {
    // 根据请求类型和上下文路由到合适的 Agent
    switch (request.type) {
      case 'council':
        return { agentType: 'council', priority: 'high' }
      case 'review':
        return { agentType: 'review', priority: 'normal' }
      case 'task':
        return this.routeTask(request)
      default:
        return { agentType: 'general', priority: 'normal' }
    }
  }
}
```

#### 2. A2A 服务支持（远程部署）

新建文件：`src/services/gateway/A2AServer.ts`

```typescript
import { WebSocketServer } from 'ws'

/**
 * Agent-to-Agent 服务
 * 支持远程部署，无需依赖 CLI
 */
export class A2AServer {
  private wss: WebSocketServer
  private gateway: AgentGateway
  
  constructor(port: number) {
    this.wss = new WebSocketServer({ port })
    this.gateway = new AgentGateway()
    this.setupHandlers()
  }
  
  private setupHandlers() {
    this.wss.on('connection', (ws, req) => {
      ws.on('message', async (data) => {
        const request: GatewayRequest = JSON.parse(data.toString())
        const response = await this.gateway.handleRequest(request)
        ws.send(JSON.stringify(response))
      })
    })
  }
  
  // 健康检查
  healthCheck(): { status: string; agents: number } {
    return {
      status: 'healthy',
      agents: this.gateway.getActiveAgents().length,
    }
  }
}
```

**实现清单**：
- [ ] `src/services/gateway/AgentGateway.ts` - 核心服务
- [ ] 请求路由逻辑
- [ ] `src/services/gateway/A2AServer.ts` - WebSocket 服务
- [ ] REST API 封装
- [ ] Docker 部署配置

**预计工时**：15 小时（约 2 天）

---

## 技术风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 并行调用延迟叠加 | 用户体验 | 使用 streaming 显示各模型进度 |
| 评分不一致 | 结果质量 | 多维度评分 + 权重机制 |
| Token 成本增加 | 成本 | 仅在复杂任务启用，配置 `minComplexity` |
| A2A 连接不稳定 | 远程调用 | 实现重试 + 本地 fallback |

---

## 验收标准

### LLM Council

- [ ] 支持 2-5 个模型并行执行
- [ ] 评分误差 < 10%（同一答案多次评分）
- [ ] 从 CLI 启动到首响应 < 5s（streaming）
- [ ] 支持配置文件 + CLI 参数两种配置方式
- [ ] 单元测试覆盖率 > 80%

### Agent Gateway

- [ ] 支持远程 WebSocket 连接
- [ ] 连接断开自动重试（最多 3 次）
- [ ] 健康检查 API 响应正常
- [ ] Docker 部署一键启动

---

## 参考资源

- [Karpathy 的 llm-council 项目](https://github.com/karpathy/llm-council)
- [Cursor 2.0 多 Agent 界面介绍](https://cursor.com/cn/blog/2-0)
- [LLM Council 机制解读](https://www.analyticsvidhya.com/blog/2025/12/llm-council-by-andrej-karpathy/)
