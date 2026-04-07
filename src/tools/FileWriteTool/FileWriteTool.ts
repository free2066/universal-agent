/**
 * FileWriteTool/FileWriteTool.ts — Write content to a file
 *
 * Mirrors claude-code's FileWriteTool.ts.
 * Includes 30-pattern secret scanner (kstack article #15375).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ToolRegistration } from '../../models/types.js';
import { fireFileChanged } from '../../core/hooks.js';

// ── Secret Detection (kstack article #15375) ─────────────────────────────────
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key ID',        pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Access Key',    pattern: /(?:aws.{0,10})?(?:secret.{0,10})?(?:access.{0,10})?key['":\s=]+[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i },
  { name: 'GCP Service Account Key', pattern: /"private_key":\s*"-----BEGIN RSA PRIVATE KEY-----/ },
  { name: 'Google API Key',           pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google OAuth Token',       pattern: /ya29\.[0-9A-Za-z_-]{68,}/ },
  { name: 'Anthropic API Key',        pattern: /sk-ant-(?:api03|api02|api01)-[A-Za-z0-9_-]{93,}/ },
  { name: 'OpenAI API Key',           pattern: /sk-[A-Za-z0-9]{48}/ },
  { name: 'OpenAI Org Key',           pattern: /org-[A-Za-z0-9]{24,}/ },
  { name: 'GitHub Token',             pattern: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{36,}/ },
  { name: 'Slack Token',              pattern: /xox[baprs]-[0-9A-Za-z\-]{10,}/ },
  { name: 'Azure Connection String',  pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{88}/ },
  { name: 'Azure SAS Token',          pattern: /sv=\d{4}-\d{2}-\d{2}&(?:st|se|spr|sv|sr|sp|sip|si|sig)=[^&"'\s]+/ },
  { name: 'RSA Private Key',          pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'PGP Private Key',          pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { name: 'Bearer Token (long)',      pattern: /[Bb]earer\s+[A-Za-z0-9+/=_-]{32,}/ },
  { name: 'Basic Auth (base64)',      pattern: /[Bb]asic\s+[A-Za-z0-9+/=]{20,}/ },
  { name: 'Database URL with auth',   pattern: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^:]+:[^@]+@/ },
  { name: 'Twilio Account SID',       pattern: /AC[a-z0-9]{32}/ },
  { name: 'Twilio Auth Token',        pattern: /SK[a-z0-9]{32}/ },
  { name: 'Stripe API Key',           pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: 'SendGrid API Key',         pattern: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}/ },
  { name: 'HuggingFace Token',        pattern: /hf_[A-Za-z0-9]{37,}/ },
  { name: 'Groq API Key',             pattern: /gsk_[A-Za-z0-9]{50,}/ },
  { name: 'Generic Hex Secret',       pattern: /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token)['":\s=]+[0-9a-fA-F]{32,}/ },
  { name: 'Env Secret Assignment',    pattern: /^(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CRED)=['"]?[A-Za-z0-9+/=_-]{20,}['"]?$/m },
  { name: 'Kubernetes Secret (b64)',  pattern: /data:\s*\n\s+[a-z-]+:\s+[A-Za-z0-9+/=]{40,}/ },
  { name: 'JWT Token',                pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'NPM Access Token',         pattern: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'Cloudflare API Token',     pattern: /(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN|cloudflare.*token|cf.*token)[^\n]*[=:\s]["']?[A-Za-z0-9_-]{37}["']?/i },
];

function detectSecrets(content: string, filePath: string): string | null {
  if (content.includes('\x00')) return null;
  const base = filePath.split('/').pop() ?? '';
  if (/^\.?env(?:\.|$)/.test(base)) return null;

  const SCAN_LIMIT = 50 * 1024;
  const scanContent = content.length > SCAN_LIMIT * 2
    ? content.slice(0, SCAN_LIMIT) + content.slice(-SCAN_LIMIT)
    : content;

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(scanContent)) return name;
  }
  return null;
}

export const writeFileTool: ToolRegistration = {
  definition: {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  backfillObservableInput(input) {
    if (typeof input['file_path'] === 'string' && !input['file_path'].startsWith('/')) {
      input['file_path'] = resolve(process.cwd(), input['file_path']);
    }
  },
  handler: async (args) => {
    const filePath = resolve(args.file_path as string);
    const content = args.content as string;

    const secretType = detectSecrets(content, filePath);
    if (secretType) {
      const isSafe = process.env.AGENT_SAFE_MODE === '1';
      if (isSafe) {
        return (
          `⚠️  BLOCKED: Potential secret detected in write content.\n` +
          `  Type: ${secretType}\n` +
          `  File: ${filePath}\n` +
          `  Safe mode prevents writing credentials to disk.\n` +
          `  If this is intentional, disable safe mode or exclude the file.`
        );
      }
      console.warn(`[secret-scan] ⚠️  Potential secret (${secretType}) detected in write to ${filePath} — proceeding (not in safe mode)`);
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      let diffSummary = '';
      if (existsSync(filePath)) {
        try {
          const oldContent = readFileSync(filePath, 'utf-8');
          const oldLines = oldContent.split('\n').length;
          const newLines = content.split('\n').length;
          diffSummary = ` (${oldLines}→${newLines} lines)`;
        } catch { /* ignore diff errors */ }
      }
      writeFileSync(filePath, content, 'utf-8');
      setImmediate(() => { try { fireFileChanged(filePath); } catch { /* non-fatal */ } });
      const lines = content.split('\n').length;
      const secretWarning = secretType ? `\n⚠️  Warning: potential secret (${secretType}) detected in written content.` : '';
      return `✓ Written ${lines} lines to ${filePath}${diffSummary}${secretWarning}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
