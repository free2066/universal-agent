/**
 * screens/WelcomeScreen.tsx — Welcome / startup screen
 *
 * Mirrors claude-code's screens/WelcomeScreen.tsx.
 * Shown on agent startup before the first user prompt.
 */

import { printBanner } from '../cli/ui-enhanced.js';

export interface WelcomeScreenOptions {
  model: string;
  domain?: string;
  version?: string;
  sessionId?: string;
}

/**
 * Display the welcome banner.
 */
export function renderWelcomeScreen(opts: WelcomeScreenOptions): void {
  printBanner();
}
