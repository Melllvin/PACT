import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable, toSpawnCommand } from '../../../src/main/env/resolve-command';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// Real pseudo-terminals (forkpty on macOS, ConPTY on Windows) driving the fake CLI.
const isWindows = process.platform === 'win32';
const stripAnsi = (text: string) =>
  // eslint-disable-next-line no-control-regex -- terminal escape sequences are the point here
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

let manager: PtyManager;
let dir: string;
let output: Map<string, string>;
let exits: Map<string, number>;

const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined) baseEnv[key] = value;
const env = (scenario = 'prompt-then-done') => ({
  ...baseEnv,
  FAKE_CLI_SCENARIO: scenarioPath(scenario),
});

const waitFor = async (id: string, text: string, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!stripAnsi(output.get(id) ?? '').includes(text)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(text)} in:\n${stripAnsi(output.get(id) ?? '')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};
const waitForExit = async (id: string) => {
  const start = Date.now();
  while (!exits.has(id)) {
    if (Date.now() - start > 10_000) throw new Error(`${id} did not exit`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return exits.get(id);
};

beforeEach(async () => {
  dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-pty-')));
  manager = new PtyManager();
  output = new Map();
  exits = new Map();
  manager.onData((id, data) => output.set(id, (output.get(id) ?? '') + data));
  manager.onExit((id, code) => exits.set(id, code));
});

afterEach(async () => {
  await manager.dispose();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('PtyManager with a real pseudo-terminal', () => {
  it('runs the CLI in the given directory, even with spaces and accents', async () => {
    const cwd = join(dir, 'Mes Projets', 'Développement');
    await mkdir(cwd, { recursive: true });
    manager.start('cwd', {
      file: process.execPath,
      args: ['-e', 'console.log("CWD=" + process.cwd())'],
      env: env(),
      cwd,
    });
    await waitForExit('cwd');
    expect(stripAnsi(output.get('cwd') ?? '').replace(/\r?\n/g, '')).toContain(`CWD=${cwd}`);
  });

  it('forwards keystrokes and runs a full turn of the fake CLI', async () => {
    manager.start('agent', { file: process.execPath, args: [FAKE_CLI], env: env(), cwd: dir });
    await waitFor('agent', '> ');
    manager.write('agent', 'Ajoute un test\r');
    await waitFor('agent', 'Terminé');
  });

  it('answers a permission question through the keyboard', async () => {
    manager.start('ask', {
      file: process.execPath,
      args: [FAKE_CLI],
      env: env('ask-permission'),
      cwd: dir,
    });
    await waitFor('ask', '> ');
    manager.write('ask', 'Nettoie\r');
    await waitFor('ask', '(allow/deny)');
    manager.write('ask', 'allow\r');
    await waitFor('ask', 'Autorisé');
  });

  it('reports the exit code', async () => {
    manager.start('crash', {
      file: process.execPath,
      args: [FAKE_CLI],
      env: env('crash-exit-1'),
      cwd: dir,
    });
    await waitFor('crash', '> ');
    manager.write('crash', 'go\r');
    expect(await waitForExit('crash')).toBe(1);
    expect(stripAnsi(manager.history('crash'))).toContain('Erreur simulée');
  });

  it('resizes the terminal', async () => {
    const script =
      'process.stdin.on("data", () => console.log("SIZE=" + process.stdout.columns + "x" + process.stdout.rows))';
    manager.start('size', {
      file: process.execPath,
      args: ['-e', script],
      env: env(),
      cwd: dir,
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setTimeout(r, 300));
    manager.write('size', 'a\r');
    await waitFor('size', 'SIZE=80x24');
    manager.resize('size', 100, 30);
    await new Promise((r) => setTimeout(r, 300));
    manager.write('size', 'b\r');
    await waitFor('size', 'SIZE=100x30');
  });

  it('stops a running CLI', async () => {
    manager.start('long', { file: process.execPath, args: [FAKE_CLI], env: env(), cwd: dir });
    await waitFor('long', '> ');
    await manager.kill('long');
    expect(manager.has('long')).toBe(false);
    expect(exits.has('long')).toBe(true);
  });

  it.runIf(isWindows)('runs an npm .cmd shim through the cmd.exe wrapper', async () => {
    const shimDir = join(dir, 'Mes Projets', 'Développement');
    await mkdir(shimDir, { recursive: true });
    await writeFile(join(shimDir, 'fake-agent.cmd'), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    const shim = await findExecutable('fake-agent', { PATH: shimDir, PATHEXT: '.CMD' }, 'win32');
    const command = toSpawnCommand(shim ?? '', ['--session-id', 'sess é 1'], 'win32', process.env);

    manager.start('shim', { ...command, env: env(), cwd: dir });
    await waitFor('shim', 'Session sess é 1');
    manager.write('shim', 'go\r');
    await waitFor('shim', 'Terminé');
  });
});
