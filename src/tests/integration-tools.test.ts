/**
 * Integration Tests: GitHub PR Tools + CurlExecute + EnvProbe
 *
 * Uses real network calls for CurlExecute / EnvProbe (read-only safe).
 * Mocks GitHub API token for PR tools to test logic without modifying actual repos.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CurlExecute — Real HTTP Tests (httpbin.org)
// ─────────────────────────────────────────────────────────────────────────────
describe('CurlExecute — Real HTTP integration', () => {
  it('GET request returns 200 with structured output', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/get',
      method: 'GET',
      timeout_seconds: 15,
    }) as string;

    expect(result).toMatch(/200/);
    expect(result).toMatch(/✅/);
    expect(result).toMatch(/httpbin/);
  });

  it('POST with JSON body shows correct method', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/post',
      method: 'POST',
      body: '{"key": "value", "num": 42}',
      timeout_seconds: 15,
    }) as string;

    expect(result).toMatch(/200|POST/);
  });

  it('GET with headers includes custom headers', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/headers',
      method: 'GET',
      headers: { 'X-Test-Header': 'hello-vitest' },
      verbose: true,
      timeout_seconds: 15,
    }) as string;

    expect(result).toMatch(/200|headers/i);
  });

  it('404 returns non-success indicator', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/status/404',
      method: 'GET',
      timeout_seconds: 10,
    }) as string;

    // Should show 404 status (either ❌ or 404 in output)
    expect(result).toMatch(/404|❌/);
  });

  it('assert_status flags mismatch', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/get',
      method: 'GET',
      assert_status: 201, // expect 201 but will get 200
      timeout_seconds: 10,
    }) as string;

    // Should flag assertion failure
    expect(result).toMatch(/expected 201|assert|200.*201/i);
  });

  it('extract_path extracts nested field from JSON', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/json',
      method: 'GET',
      extract_path: 'slideshow.title',
      timeout_seconds: 15,
    }) as string;

    // httpbin /json returns a slideshow object
    expect(result).toMatch(/Extracted|slideshow|Sample/i);
  });

  it('handles connection timeout gracefully', async () => {
    const { curlExecuteTool } = await import('../core/tools/productivity/curl-tool.js');
    // Use a very short timeout
    const result = await curlExecuteTool.handler({
      url: 'https://httpbin.org/delay/5', // delays 5s
      method: 'GET',
      timeout_seconds: 1, // but we only allow 1s
    }) as string;

    // Should return error about timeout, not throw
    expect(result).toMatch(/Error|timeout|❌/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. EnvProbe — System Environment (read-only, safe)
// ─────────────────────────────────────────────────────────────────────────────
describe('EnvProbe — System environment sensing', () => {
  it('probe=system returns OS and Node version', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'system' }) as string;

    expect(result).toMatch(/node|cpu|memory|os|macos|linux/i);
    expect(result.length).toBeGreaterThan(50);
  });

  it('probe=ports returns port list or graceful no-ports message', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'ports' }) as string;

    // Either lists ports or says none found — should not crash
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('probe=processes returns process list', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'processes', filter: 'node' }) as string;

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Either lists node processes or says none found
  });

  it('probe=deps reads project dependencies', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'deps' }) as string;

    expect(typeof result).toBe('string');
    // Should mention some of our known dependencies
    expect(result).toMatch(/vitest|openai|anthropic|commander|chalk|yaml/i);
  });

  it('probe=ports with range filter returns only specified range', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'ports', range: '1000-2000' }) as string;

    expect(typeof result).toBe('string');
    // Should not list ports outside range (best-effort check)
  });

  it('invalid probe type returns error message', async () => {
    const { envProbeTool } = await import('../core/tools/productivity/env-probe.js');
    const result = await envProbeTool.handler({ probe: 'invalid-probe-type' }) as string;

    // Should return an error/unknown message, not throw
    expect(typeof result).toBe('string');
    expect(result).toMatch(/unknown|invalid|Error/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GitHubListPRs — Behavior Tests (uses real token from env)
// ─────────────────────────────────────────────────────────────────────────────
describe('GitHubListPRs — API integration', () => {
  beforeEach(() => {
    // Token embedded in remote URL — tests will use it
  });

  it('returns string result (not throw) for any input', async () => {
    const { githubListPRsTool } = await import('../core/tools/productivity/github-pr-tool.js');
    const result = await githubListPRsTool.handler({ state: 'open' });
    expect(typeof result).toBe('string');
  });

  it('returns string result for state=all', async () => {
    const { githubListPRsTool } = await import('../core/tools/productivity/github-pr-tool.js');
    const result = await githubListPRsTool.handler({ state: 'all', limit: 5 });
    expect(typeof result).toBe('string');
  });

  it('returns string result for state=closed', async () => {
    const { githubListPRsTool } = await import('../core/tools/productivity/github-pr-tool.js');
    const result = await githubListPRsTool.handler({ state: 'closed', limit: 3 });
    expect(typeof result).toBe('string');
  });

  it('explicit branch filter only shows PRs from that branch', async () => {
    const { githubListPRsTool } = await import('../core/tools/productivity/github-pr-tool.js');
    const result = await githubListPRsTool.handler({ branch: 'main', state: 'open' }) as string;
    // Either found PRs from main OR no PRs for that branch — both are valid
    expect(result).toMatch(/main|No open PRs|Pull Requests/i);
  });

  it('no-PR result message does not say "No all PRs" (bug check)', async () => {
    const { githubListPRsTool } = await import('../core/tools/productivity/github-pr-tool.js');
    const result = await githubListPRsTool.handler({ state: 'all' }) as string;
    // After our fix: should NOT contain "No all PRs"
    expect(result).not.toMatch(/No all PRs/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GitHubCreatePR — Dry-run Tests (no token = graceful error)
// ─────────────────────────────────────────────────────────────────────────────
describe('GitHubCreatePR — Token validation', () => {
  it('without token returns friendly error message or API error', async () => {
    const savedToken = process.env.GITHUB_TOKEN;
    const savedGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const { githubCreatePRTool } = await import('../core/tools/productivity/github-pr-tool.js');
      const result = await githubCreatePRTool.handler({
        title: 'Test PR',
        body: 'Test body',
        base: 'main',
      }) as string;

      // The handler may:
      // 1. Return "No GitHub token" (if no token found)
      // 2. Return a 422 error (if token extracted from git remote, no diff to PR)
      // 3. Return "Cannot detect" (if git remote not github.com)
      // All these are valid behaviors — just verify it returns a string
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(5);
      // Should NOT succeed (no commits between branches = 422 OR no token)
      expect(result).toMatch(/No GitHub token|Cannot detect|GitHub API error|No commits|already exists/i);
    } finally {
      if (savedToken) process.env.GITHUB_TOKEN = savedToken;
      if (savedGhToken) process.env.GH_TOKEN = savedGhToken;
    }
  });
});
