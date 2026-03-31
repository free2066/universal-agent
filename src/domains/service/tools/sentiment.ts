import type { ToolRegistration } from '../../../models/types.js';

export const sentimentTool: ToolRegistration = {
  definition: {
    name: 'analyze_sentiment',
    description: 'Analyze customer message sentiment and urgency level',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Customer message to analyze' },
      },
      required: ['message'],
    },
  },
  handler: async (args) => {
    const { message } = args as { message: string };
    const lower = message.toLowerCase();

    // Simple keyword-based sentiment scoring
    const positiveWords = ['thank', 'great', 'excellent', 'happy', 'satisfied', 'love', 'perfect', 'awesome', 'good', 'pleased'];
    const negativeWords = ['terrible', 'awful', 'horrible', 'worst', 'hate', 'angry', 'frustrated', 'disappointed', 'unacceptable', 'ridiculous'];
    const urgentWords = ['urgent', 'immediately', 'asap', 'emergency', 'critical', 'now', 'right away', 'immediately'];

    let positiveScore = 0;
    let negativeScore = 0;
    let urgencyScore = 0;

    for (const w of positiveWords) if (lower.includes(w)) positiveScore++;
    for (const w of negativeWords) if (lower.includes(w)) negativeScore++;
    for (const w of urgentWords) if (lower.includes(w)) urgencyScore++;

    // Punctuation signals
    const exclamations = (message.match(/!/g) || []).length;
    const capsRatio = (message.replace(/[^A-Z]/g, '').length / message.replace(/[^a-zA-Z]/g, '').length) || 0;
    if (exclamations > 2) negativeScore += 1;
    if (capsRatio > 0.5) negativeScore += 1;

    let sentiment: string;
    let score: number;
    if (negativeScore > positiveScore + 1) {
      sentiment = 'negative';
      score = -Math.min(negativeScore / 5, 1);
    } else if (positiveScore > negativeScore + 1) {
      sentiment = 'positive';
      score = Math.min(positiveScore / 5, 1);
    } else {
      sentiment = 'neutral';
      score = 0;
    }

    const urgency = urgencyScore > 0 ? 'high' : negativeScore > 2 ? 'medium' : 'low';

    return {
      sentiment,
      score: parseFloat(score.toFixed(2)),
      urgency,
      signals: {
        positive_keywords: positiveScore,
        negative_keywords: negativeScore,
        urgency_keywords: urgencyScore,
        exclamations,
        caps_ratio: parseFloat(capsRatio.toFixed(2)),
      },
      recommendation:
        sentiment === 'negative'
          ? 'Prioritize this ticket and respond with empathy'
          : urgency === 'high'
          ? 'Respond quickly — customer seems impatient'
          : 'Standard response time is acceptable',
    };
  },
};
