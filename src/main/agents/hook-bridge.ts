// research.md R4 — hook command for CLIs that only run command hooks (e.g. Codex). Launched as
// `"<Electron>" hook-bridge.js` with ELECTRON_RUN_AS_NODE=1, so users need neither Node nor curl.
// It forwards the JSON payload read from stdin to PACT and prints PACT's answer on stdout. With
// `--notify <json>` (Codex `notify`), the payload is the last argument and stdin is not read.
// With `--statusline` (005 R1), the payload is Claude Code's statusLine JSON: it goes to
// `/statusline`, and the user's own statusLine command, if any, still prints the line.
// Keep this file free of dependencies: it is bundled on its own.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type RelayOptions = {
  stdin: AsyncIterable<Buffer | string>;
  stdout: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  argv?: string[];
};

export async function relayHook({ stdin, stdout, env, argv = [] }: RelayOptions): Promise<void> {
  if (argv[0] === '--statusline') {
    await relayStatusLine({ stdin, stdout, env });
    return;
  }
  const url = env.PACT_HOOK_URL;
  if (!url) return;
  let body = argv[0] === '--notify' ? (argv.at(-1) ?? '') : '';
  if (argv[0] !== '--notify') for await (const chunk of stdin) body += chunk.toString();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pact-token': env.PACT_AGENT_TOKEN ?? '' },
      body: body || '{}',
    });
    if (response.ok) stdout.write(await response.text());
  } catch {
    // PACT is gone or restarting: a hook must never make the agent CLI fail.
  }
}

/** How long the user's own statusLine may take (contracts/sources.md). */
export const USER_STATUSLINE_TIMEOUT_MS = 2_000;

/**
 * The user's statusLine command, read only: user settings, then the project's, the last one
 * found winning as in Claude Code. PACT's own goes through `--settings`, never these files.
 */
export async function userStatusLine(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<string | null> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  const files = [
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  let command: string | null = null;
  for (const file of files) {
    try {
      const settings = JSON.parse(await readFile(file, 'utf8')) as {
        statusLine?: { type?: unknown; command?: unknown };
      };
      const line = settings.statusLine;
      if (line?.type === 'command' && typeof line.command === 'string') command = line.command;
    } catch {
      // No such file, or not JSON: Claude Code would skip it too.
    }
  }
  return command;
}

/** Runs `command` in a shell with `input`, as Claude Code would; '' after the timeout. */
function runStatusLine(command: string, input: string, env: Record<string, string | undefined>) {
  return new Promise<string>((resolve) => {
    let output = '';
    const child = spawn(command, { shell: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      resolve('');
    }, USER_STATUSLINE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function relayStatusLine({ stdin, stdout, env }: Omit<RelayOptions, 'argv'>) {
  let body = '';
  for await (const chunk of stdin) body += chunk.toString();
  const posted = postStatusLine(env, body);
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(body) as { cwd?: unknown };
    if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
  } catch {
    // Not JSON: PACT will say so; the user's command still gets it.
  }
  const own = await userStatusLine(env, cwd);
  const ownEnv = { ...env };
  delete ownEnv.ELECTRON_RUN_AS_NODE;
  const line = own === null ? await posted : await runStatusLine(own, body, ownEnv);
  await posted;
  stdout.write(line);
}

async function postStatusLine(env: Record<string, string | undefined>, body: string) {
  if (!env.PACT_HOOK_URL) return '';
  try {
    const response = await fetch(new URL('/statusline', env.PACT_HOOK_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pact-token': env.PACT_AGENT_TOKEN ?? '' },
      body: body || '{}',
    });
    return response.ok ? await response.text() : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void relayHook({
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    argv: process.argv.slice(2),
  });
}
