/**
 * input-queue.ts — D31: mid-turn 用户输入队列
 *
 * 对标 claude-code src/utils/messageQueueManager.ts（简化版）
 *
 * 功能：当 agent 正在处理（LLM 运行中）时，缓存用户输入而非丢弃，
 * agent 完成后自动消费队列中积压的输入。
 *
 * 简化点（相对 claude-code 三优先级队列）：
 *   - 单优先级 FIFO（不区分 now/next/later）
 *   - 无 React useSyncExternalStore 接口（CLI 不需要）
 *   - 无 popAllEditable（CLI 无 UP 键合并编辑功能）
 *
 * Mirrors: claude-code messageQueueManager.ts commandQueue + enqueue/dequeue/clear
 */

interface QueuedInput {
  text: string;
  timestamp: number;
}

const _queue: QueuedInput[] = [];

export const inputQueue = {
  /**
   * D31: 将输入文本推入队列末尾。
   * 在 agent 运行期间调用（rl.on('line') 中检测到 _isAgentRunning 时）。
   * Mirrors claude-code commandQueue.push({ type, text, priority: 'next' })
   */
  enqueue(text: string): void {
    _queue.push({ text, timestamp: Date.now() });
  },

  /**
   * D31: 从队列头部取出并移除一条输入。
   * 在 agent 完成后的 finally 块中调用。
   * Mirrors claude-code dequeueCommand()
   */
  dequeue(): string | undefined {
    return _queue.shift()?.text;
  },

  /**
   * D31: 查看队列头部但不移除。
   */
  peek(): string | undefined {
    return _queue[0]?.text;
  },

  /**
   * D31: 当前队列长度。
   */
  get length(): number {
    return _queue.length;
  },

  /**
   * D31: 清空队列（用户 Esc 取消时调用，同 claude-code clearCommandQueue）。
   */
  clear(): void {
    _queue.length = 0;
  },
};
