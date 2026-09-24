import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// research.md R3 — an app started from the Finder gets a minimal PATH; the user's CLIs are only
// found through the environment of their login shell.

export const SHELL_ENV_TIMEOUT_MS = 3000;
/** Printed right before the environment, so login banners and rc-file output are skipped. */
export const ENV_MARKER = '__PACT_SHELL_ENV__';
const SCRIPT = `echo ${ENV_MARKER}; env -0`;

export type ResolvedEnv = Record<string, string>;
export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

/** Parses `env -0` output (NUL-separated, so values may contain newlines) after the marker. */
export function parseShellEnv(output: string): ResolvedEnv | null {
  const start = output.indexOf(`${ENV_MARKER}\n`);
  if (start === -1) return null;
  const env: ResolvedEnv = {};
  for (const entry of output.slice(start + ENV_MARKER.length + 1).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

const execFileAsync = promisify(execFile);

export const execFileRunner: ShellRunner = async (shell, args, timeoutMs) =>
  (await execFileAsync(shell, args, { timeout: timeoutMs, encoding: 'utf8' })).stdout;

const definedOnly = (env: Record<string, string | undefined>): ResolvedEnv =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

type ResolverOptions = {
  platform: NodeJS.Platform;
  baseEnv: Record<string, string | undefined>;
  run: ShellRunner;
};

/** Returns a cached resolver of the login-shell environment, falling back to `baseEnv`. */
export function createShellEnvResolver({ platform, baseEnv, run }: ResolverOptions) {
  let pending: Promise<ResolvedEnv> | undefined;

  const resolveOnce = async (): Promise<ResolvedEnv> => {
    const base = definedOnly(baseEnv);
    // Windows apps inherit the user PATH from the session: no login shell to ask.
    if (platform === 'win32') return base;
    try {
      const output = await run(base.SHELL ?? '/bin/sh', ['-ilc', SCRIPT], SHELL_ENV_TIMEOUT_MS);
      const shellEnv = parseShellEnv(output);
      return shellEnv ? { ...base, ...shellEnv } : base;
    } catch {
      return base;
    }
  };

  return () => (pending ??= resolveOnce());
}

export const resolveShellEnv = createShellEnvResolver({
  platform: process.platform,
  baseEnv: process.env,
  run: execFileRunner,
});
