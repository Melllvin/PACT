import { findExecutable } from '../../env/resolve-command';
import type { CommandRunner, DetectionResult, HookBridge, ResolvedEnv } from './types';

// Helpers shared by the real CLI adapters (Claude Code, Codex).

/** First `x.y.z` found in a `--version` output. */
export const parseVersion = (output: string): string | null =>
  /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null;

/** `true` when `version` is at least `minimum` (both `x.y.z`). */
export function isAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split('.').map(Number);
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** Output of a detection command, or null when it fails: detection never throws. */
export async function tryRun(run: CommandRunner, file: string, args: string[], env: ResolvedEnv) {
  try {
    return await run(file, args, env);
  } catch {
    return null;
  }
}

/**
 * Locates `command` and reads its version. A CLI whose version cannot be read stays usable
 * (`installed`, version null); only a version known to be too old is `unsupported-version`.
 */
export async function detectCommand(
  command: string,
  minimum: string,
  { env, platform, run }: { env: ResolvedEnv; platform: NodeJS.Platform; run: CommandRunner },
): Promise<DetectionResult> {
  const resolvedPath = await findExecutable(command, env, platform);
  if (!resolvedPath) return { resolvedPath: null, version: null, status: 'missing' };
  const output = await tryRun(run, resolvedPath, ['--version'], env);
  const version = output === null ? null : parseVersion(output);
  const status = version && !isAtLeast(version, minimum) ? 'unsupported-version' : 'installed';
  return { resolvedPath, version, status };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Shell command running the hook bridge. ELECTRON_RUN_AS_NODE is set for the bridge only: set in
 * the agent's environment, it would turn any Electron app the agent starts into plain Node.
 */
export const bridgeCommand = ({ executable, script }: HookBridge, ...args: string[]) =>
  ['ELECTRON_RUN_AS_NODE=1', ...[executable, script, ...args].map(shellQuote)].join(' ');

/**
 * Next occurrence of a clock time written like `3pm`, `9:30am` or `3:45 PM` after `pattern`
 * (e.g. « resets », « try again at »), or null when the text has none.
 */
export function nextClockTime(text: string, pattern: RegExp, now: Date): Date | null {
  const time = new RegExp(`${pattern.source}\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)`, 'i');
  const match = time.exec(text);
  if (!match) return null;
  const hour12 = Number(match[1]) % 12;
  const hour = match[3]?.toLowerCase() === 'pm' ? hour12 + 12 : hour12;
  const reset = new Date(now);
  reset.setHours(hour, Number(match[2] ?? 0), 0, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1);
  return reset;
}
