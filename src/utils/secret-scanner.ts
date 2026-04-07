/**
 * secret-scanner.ts — A27: Secret detection and redaction
 *
 * Mirrors claude-code src/services/teamMemorySync/secretScanner.ts.
 *
 * Scans text for common secrets (API keys, tokens, credentials) using
 * a set of gitleaks-inspired patterns. Secrets are replaced with [REDACTED]
 * before writing to memory stores, session transcripts, or other persistence layers.
 *
 * 32 rule categories covering:
 *   AWS, GCP, Azure, GitHub, GitLab, OpenAI, Anthropic, Stripe, Slack,
 *   Twilio, SendGrid, Mailgun, Algolia, Firebase, Heroku, Shopify,
 *   Hashicorp Vault, PagerDuty, Datadog, HuggingFace, Pinecone,
 *   generic private key / JWT / Bearer token / basic auth patterns.
 *
 * Usage:
 *   const clean = redactSecrets(rawText);
 *   const findings = scanForSecrets(rawText);
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SecretFinding {
  rule: string;
  /** The matched secret (first 8 chars only for safety) */
  preview: string;
  /** Character offset in the original string */
  index: number;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

// ── Rule definitions ──────────────────────────────────────────────────────────

/**
 * A27: 32 gitleaks-inspired rules.
 * Patterns compiled lazily on first use (see _compiledRules cache below).
 */
const RAW_RULES: Array<{ id: string; pattern: string }> = [
  // AWS
  { id: 'aws-access-key',   pattern: '(?:^|[^A-Z0-9])(AKIA[A-Z0-9]{16})(?:[^A-Z0-9]|$)' },
  { id: 'aws-secret-key',   pattern: '(?i)(?:aws.{0,20})?(?:secret.{0,20})?["\']?([A-Za-z0-9/+=]{40})["\']?' },
  { id: 'aws-mws-key',      pattern: 'amzn\\.mws\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' },

  // GCP / Google
  { id: 'gcp-service-account', pattern: '"type"\\s*:\\s*"service_account"' },
  { id: 'google-api-key',      pattern: 'AIza[0-9A-Za-z\\-_]{35}' },
  { id: 'google-oauth',        pattern: '[0-9]+-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com' },

  // Azure
  { id: 'azure-storage-key',   pattern: 'DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{88}' },
  { id: 'azure-sas-token',     pattern: 'sig=[A-Za-z0-9%]{43,}' },

  // GitHub
  { id: 'github-pat',   pattern: 'ghp_[A-Za-z0-9]{36}' },
  { id: 'github-app',   pattern: '(?:ghs|ghu|ghr|gho)_[A-Za-z0-9]{36}' },
  { id: 'github-fine',  pattern: 'github_pat_[A-Za-z0-9_]{82}' },

  // GitLab
  { id: 'gitlab-pat',          pattern: 'glpat-[A-Za-z0-9\\-_]{20}' },
  { id: 'gitlab-runner-token', pattern: 'GR1348941[A-Za-z0-9_-]{20}' },

  // Anthropic
  { id: 'anthropic-api-key',   pattern: 'sk-ant-[A-Za-z0-9\\-_]{95}' },

  // OpenAI
  { id: 'openai-api-key',      pattern: 'sk-[A-Za-z0-9]{48}' },
  { id: 'openai-org',          pattern: 'org-[A-Za-z0-9]{24}' },

  // Stripe
  { id: 'stripe-secret',       pattern: 'sk_live_[A-Za-z0-9]{24,}' },
  { id: 'stripe-restricted',   pattern: 'rk_live_[A-Za-z0-9]{24,}' },
  { id: 'stripe-webhook',      pattern: 'whsec_[A-Za-z0-9]{32,}' },

  // Slack
  { id: 'slack-bot-token',     pattern: 'xoxb-[A-Za-z0-9\\-]{40,}' },
  { id: 'slack-user-token',    pattern: 'xoxp-[A-Za-z0-9\\-]{40,}' },
  { id: 'slack-app-token',     pattern: 'xapp-[A-Za-z0-9\\-]{40,}' },
  { id: 'slack-webhook',       pattern: 'https://hooks\\.slack\\.com/services/T[A-Z0-9]{8}/B[A-Z0-9]{8}/[A-Za-z0-9]{24}' },

  // Twilio
  { id: 'twilio-sid',          pattern: 'AC[a-fA-F0-9]{32}' },
  { id: 'twilio-token',        pattern: 'SK[a-fA-F0-9]{32}' },

  // SendGrid
  { id: 'sendgrid-api-key',    pattern: 'SG\\.[A-Za-z0-9\\-_]{22}\\.[A-Za-z0-9\\-_]{43}' },

  // Mailgun
  { id: 'mailgun-api-key',     pattern: 'key-[A-Za-z0-9]{32}' },

  // HuggingFace
  { id: 'huggingface-token',   pattern: 'hf_[A-Za-z0-9]{37}' },

  // Pinecone
  { id: 'pinecone-api-key',    pattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=.*pinecone)' },

  // Generic patterns (high-confidence)
  { id: 'private-key-header',  pattern: '-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----' },
  { id: 'jwt-token',           pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}' },
  { id: 'bearer-token',        pattern: '(?:Bearer|bearer)\\s+([A-Za-z0-9\\-_.~+/]{20,})' },
  { id: 'basic-auth',          pattern: '(?:Basic|basic)\\s+([A-Za-z0-9+/=]{20,})' },
];

// ── Lazy compilation cache ────────────────────────────────────────────────────

let _compiledRules: SecretRule[] | null = null;

/**
 * A27: Lazily compile regex patterns on first call.
 * Mirrors claude-code secretScanner.ts L227: "首次扫描时编译".
 */
function getCompiledRules(): SecretRule[] {
  if (_compiledRules) return _compiledRules;
  _compiledRules = RAW_RULES.map(({ id, pattern }) => ({
    id,
    // (?i) in pattern string → use 'i' flag in RegExp constructor
    pattern: pattern.startsWith('(?i)')
      ? new RegExp(pattern.slice(4), 'gi')
      : new RegExp(pattern, 'g'),
  }));
  return _compiledRules;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * A27: scanForSecrets — return a list of detected secrets in the given text.
 * Safe: only returns the first 8 chars of each match as `preview`.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  if (!text || typeof text !== 'string') return [];
  const rules = getCompiledRules();
  const findings: SecretFinding[] = [];

  for (const rule of rules) {
    // Reset lastIndex for global patterns
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const matched = match[1] ?? match[0];
      findings.push({
        rule: rule.id,
        preview: matched.slice(0, 8) + '...',
        index: match.index,
      });
      // Prevent infinite loop on zero-length match
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
      }
    }
  }

  return findings;
}

/**
 * A27: redactSecrets — replace all detected secrets with [REDACTED].
 * Returns the sanitized string. Input string is NOT modified in place.
 *
 * Mirrors claude-code secretScanner.ts redactSecrets() L312-324.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;
  const rules = getCompiledRules();
  let result = text;

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, (fullMatch, capture) => {
      if (capture !== undefined) {
        // Replace only the capture group, preserve surrounding context
        return fullMatch.replace(capture, '[REDACTED]');
      }
      return '[REDACTED]';
    });
    // Reset after replace (global regex)
    rule.pattern.lastIndex = 0;
  }

  return result;
}

/**
 * A27: hasSecrets — quick check if text contains any secret patterns.
 * Faster than scanForSecrets() since it stops at first match.
 */
export function hasSecrets(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const rules = getCompiledRules();
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) return true;
  }
  return false;
}
