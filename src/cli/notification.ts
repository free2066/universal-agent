/**
 * notification.ts — Session completion notifications.
 *
 * Aligns with CodeFlicker CLI `notification` config:
 *   false         — disabled (default)
 *   true          — play default sound ("Funk" on macOS)
 *   "<SoundName>" — play that macOS system sound (/System/Library/Sounds/)
 *   "http://..."  — send HTTP GET to the URL (webhook)
 *
 * macOS sounds: Basso Blow Bottle Frog Funk Glass Hero Morse Ping Pop Purr Sosumi Submarine Tink
 * Linux / Windows: fall back to terminal bell (\x07)
 *
 * Template variables in webhook URLs:
 *   {{cwd}}  — current working directory
 *   {{name}} — basename of cwd
 */

import { spawnSync } from 'child_process';
import { basename } from 'path';

const MACOS_SOUNDS_DIR = '/System/Library/Sounds';
const DEFAULT_SOUND    = 'Funk';

/**
 * Trigger a notification based on the `notification` config value.
 * Called when a REPL session ends or a major task completes.
 */
export async function triggerNotification(value: boolean | string): Promise<void> {
  if (value === false || value === undefined || value === null) return;

  // Webhook: URL starts with http:// or https://
  if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
    const cwd  = process.cwd();
    const name = basename(cwd);
    const url  = value
      .replace(/\{\{cwd\}\}/g, encodeURIComponent(cwd))
      .replace(/\{\{name\}\}/g, encodeURIComponent(name));
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    } catch {
      // Webhook errors are non-fatal
    }
    return;
  }

  // Sound notification
  const soundName = typeof value === 'string' ? value : DEFAULT_SOUND;

  if (process.platform === 'darwin') {
    // macOS: use `afplay` to play system sound
    const soundPath = `${MACOS_SOUNDS_DIR}/${soundName}.aiff`;
    spawnSync('afplay', [soundPath], { stdio: 'ignore', timeout: 3000 });
  } else {
    // Linux / Windows fallback: terminal bell
    process.stdout.write('\x07');
  }
}
