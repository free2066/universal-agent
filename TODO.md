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
