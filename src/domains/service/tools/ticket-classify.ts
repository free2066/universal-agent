import type { ToolRegistration } from '../../../models/types.js';

export const ticketClassifyTool: ToolRegistration = {
  definition: {
    name: 'classify_ticket',
    description: 'Classify a customer support ticket by priority, category, and suggested actions',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The customer message or ticket content' },
        customer_tier: {
          type: 'string',
          description: 'Customer tier: free | premium | enterprise',
          enum: ['free', 'premium', 'enterprise'],
        },
      },
      required: ['message'],
    },
  },
  handler: async (args) => {
    const { message, customer_tier = 'free' } = args as {
      message: string;
      customer_tier: string;
    };

    // Rule-based pre-classification (LLM will refine)
    const lower = message.toLowerCase();

    let priority = 'MEDIUM';
    const categories: string[] = [];
    const flags: string[] = [];

    // Priority detection
    if (/payment|charge|billing|refund|money|credit card/.test(lower)) {
      priority = 'HIGH';
      categories.push('billing');
    }
    if (/data loss|breach|security|hack|stolen|unauthorized/.test(lower)) {
      priority = 'CRITICAL';
      categories.push('security');
      flags.push('SECURITY_ISSUE');
    }
    if (/can't login|cannot login|locked out|account disabled/.test(lower)) {
      priority = 'HIGH';
      categories.push('authentication');
    }
    if (/bug|error|crash|not working|broken/.test(lower)) {
      categories.push('technical_issue');
    }
    if (/feature request|would be nice|suggestion/.test(lower)) {
      priority = 'LOW';
      categories.push('feature_request');
    }
    if (/angry|furious|terrible|worst|lawsuit|lawyer/.test(lower)) {
      flags.push('ESCALATION_NEEDED');
      priority = priority === 'MEDIUM' ? 'HIGH' : priority;
    }

    // Upgrade priority for enterprise customers
    if (customer_tier === 'enterprise' && priority === 'MEDIUM') priority = 'HIGH';

    const sla: Record<string, string> = {
      CRITICAL: '1 hour',
      HIGH: '4 hours',
      MEDIUM: '24 hours',
      LOW: '72 hours',
    };

    return {
      priority,
      categories: categories.length ? categories : ['general'],
      flags,
      customer_tier,
      sla_target: sla[priority],
      suggested_team: priority === 'CRITICAL' ? 'senior_support' : 'regular_support',
      word_count: message.split(' ').length,
    };
  },
};
