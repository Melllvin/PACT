import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `statusLine.refreshInterval` (seconds) of the user's own Claude Code settings, `null` when there
 * is none or the file cannot be read. Read only: the user's configuration is never written.
 */
export function userStatusLineInterval(env: Record<string, string | undefined>): number | null {
  try {
    const folder = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
    const settings: unknown = JSON.parse(readFileSync(join(folder, 'settings.json'), 'utf8'));
    const line = (settings as { statusLine?: { refreshInterval?: unknown } } | null)?.statusLine;
    const interval = line?.refreshInterval;
    return typeof interval === 'number' && Number.isFinite(interval) && interval > 0
      ? interval
      : null;
  } catch {
    return null;
  }
}
