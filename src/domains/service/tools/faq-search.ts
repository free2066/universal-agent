import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

export const faqSearchTool: ToolRegistration = {
  definition: {
    name: 'search_faq',
    description: 'Search FAQ knowledge base for answers to common questions',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The customer question to search for' },
        faq_file: {
          type: 'string',
          description: 'Optional path to a custom FAQ JSON file',
        },
      },
      required: ['query'],
    },
  },
  handler: async (args) => {
    const { query, faq_file } = args as { query: string; faq_file?: string };

    // Try to load custom FAQ
    let faqData: Array<{ question: string; answer: string; tags: string[] }> = DEFAULT_FAQ;

    if (faq_file) {
      const faqPath = resolve(faq_file);
      if (existsSync(faqPath)) {
        try {
          faqData = JSON.parse(readFileSync(faqPath, 'utf-8'));
        } catch {
          // Use default if parse fails
        }
      }
    }

    // Simple keyword search
    const queryWords = query.toLowerCase().split(/\s+/);
    const scored = faqData.map((item) => {
      const combined = (item.question + ' ' + item.tags.join(' ')).toLowerCase();
      const score = queryWords.filter((w) => combined.includes(w)).length;
      return { ...item, score };
    });

    const matches = scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (!matches.length) {
      return {
        found: false,
        message: 'No matching FAQ found. Please generate a custom response.',
        query,
      };
    }

    return {
      found: true,
      matches: matches.map((m) => ({ question: m.question, answer: m.answer, relevance: m.score })),
    };
  },
};

const DEFAULT_FAQ = [
  {
    question: 'How do I reset my password?',
    answer: 'Go to Settings > Security > Reset Password. Enter your email and follow the instructions sent to you.',
    tags: ['password', 'reset', 'login', 'account', 'forgot'],
  },
  {
    question: 'How do I request a refund?',
    answer: 'Refunds can be requested within 30 days of purchase. Go to Order History, select the order, and click "Request Refund".',
    tags: ['refund', 'money', 'charge', 'payment', 'cancel'],
  },
  {
    question: 'How do I contact support?',
    answer: 'You can reach our support team via email at support@example.com or through the in-app chat.',
    tags: ['contact', 'support', 'help', 'email', 'chat'],
  },
  {
    question: 'What are your business hours?',
    answer: 'Our support team is available Monday-Friday 9AM-6PM EST. Enterprise customers have 24/7 support.',
    tags: ['hours', 'available', 'time', 'business', 'schedule'],
  },
  {
    question: 'How do I cancel my subscription?',
    answer: 'Go to Settings > Billing > Cancel Subscription. Your access continues until the end of the billing period.',
    tags: ['cancel', 'subscription', 'billing', 'stop', 'unsubscribe'],
  },
];
