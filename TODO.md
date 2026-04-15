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

### [ ] LLM Council 多模型并行分析择优（Phase 1）

**背景**：参考 Jarvis 文档的 LLM Council 设计理念，让多个模型并行分析同一问题，通过评分机制择优输出，提高复杂任务的准确率。

**核心机制（三阶段）**：
1. **并行生成**：同时向 2-5 个模型发送相同 prompt
2. **交叉评分**：各模型相互评分（correctness, completeness, code_quality）
3. **择优决策**：highest_score / majority_vote / chairman_decision

**实现清单**：
- [ ] `src/config/councilConfig.ts` - Council 配置系统
- [ ] `src/tools/CouncilTool/CouncilExecutor.ts` - 执行器
- [ ] `src/tools/CouncilTool/CouncilTool.ts` - 工具定义
- [ ] 评分 Prompt 工程
- [ ] CLI 参数支持 `--council`
- [ ] 单元测试

**预计工时**：14 小时（约 2 天）

### [ ] Agent Gateway 统一调度入口（Phase 2）

**背景**：增强 universal-agent 作为统一 Agent 网关的能力，支持远程部署和 A2A 通信，无需依赖 CLI。

**架构设计**：
```
API Gateway Layer (REST/gRPC/WebSocket)
         ↓
    Agent Router (请求分析 + 智能路由)
         ↓
    Agent Pool (CodeGen/Review/Council/...)
```

**实现清单**：
- [ ] `src/services/gateway/AgentGateway.ts` - 核心服务
- [ ] 请求路由逻辑
- [ ] `src/services/gateway/A2AServer.ts` - WebSocket 服务
- [ ] REST API 封装
- [ ] Docker 部署配置

**预计工时**：15 小时（约 2 天）

**详细计划**：见 `.codeflicker/mem-bank/threads/universal-agent-46c34a/09gistm9vjwn01264omj/plan/LLM-Council与Agent-Gateway实现_nekkpe/plan.md`
