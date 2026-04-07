/**
 * services/metrics/index.ts — Metrics collection service
 *
 * Mirrors claude-code's services/metrics/index.ts.
 * Tracks LLM call statistics with JSONL persistence.
 */

export {
  LlmCallEvent,
  MetricEvent,
  SessionStats,
  MetricsCollector,
  sessionMetrics,
} from '../../core/metrics.js';
