import chalk from 'chalk';
import type { DomainPlugin } from '../models/types.js';
import type { ToolRegistry } from './tool-registry.js';
import { dataDomain } from '../domains/data/index.js';
import { devDomain } from '../domains/dev/index.js';
import { serviceDomain } from '../domains/service/index.js';

const DOMAINS: Record<string, DomainPlugin> = {
  data: dataDomain,
  dev: devDomain,
  service: serviceDomain,
};

export class DomainRouter {
  detectDomain(prompt: string): string {
    const lower = prompt.toLowerCase();

    const scores: Record<string, number> = { data: 0, dev: 0, service: 0 };

    for (const [name, plugin] of Object.entries(DOMAINS)) {
      for (const kw of plugin.keywords) {
        if (lower.includes(kw)) scores[name]++;
      }
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : 'dev'; // fallback to dev
  }

  getSystemPrompt(domain: string): string {
    const plugin = DOMAINS[domain] || DOMAINS['dev'];
    return plugin.systemPrompt;
  }

  registerTools(registry: ToolRegistry, domain: string) {
    if (domain === 'auto') {
      // Register all domain tools for auto mode
      for (const plugin of Object.values(DOMAINS)) {
        registry.registerMany(plugin.tools);
      }
    } else {
      const plugin = DOMAINS[domain];
      if (plugin) registry.registerMany(plugin.tools);
    }
  }

  listDomains() {
    console.log(chalk.yellow('\n🌐 Available Domains:\n'));
    for (const [name, plugin] of Object.entries(DOMAINS)) {
      console.log(chalk.cyan(`  ${name.padEnd(10)}`) + chalk.white(plugin.description));
      console.log(chalk.gray(`  ${''.padEnd(10)}Tools: ${plugin.tools.map((t) => t.definition.name).join(', ')}\n`));
    }
  }
}
