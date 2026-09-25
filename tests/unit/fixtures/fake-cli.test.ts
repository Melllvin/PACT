import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

type Hook = { body: Record<string, unknown>; headers: IncomingHttpHeaders };

let server: Server | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let tmp: string | undefined;

afterEach(async () => {
  // Wait for the process to be gone: Windows keeps its working directory locked until then.
  const running = child;
  if (running && running.exitCode === null && running.signalCode === null) {
    const exited = new Promise((resolve) => running.once('exit', resolve));
    running.kill();
    await exited;
  }
  await new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve(undefined);
  });
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  server = child = tmp = undefined;
});

async function startHookServer(hooks: Hook[]) {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      hooks.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
}

async function runFake(scenario: string, { args = [] as string[], cwd = process.cwd() } = {}) {
  const hooks: Hook[] = [];
  const url = await startHookServer(hooks);
  const proc = spawn(process.execPath, [FAKE_CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      FAKE_CLI_SCENARIO: scenarioPath(scenario),
      PACT_HOOK_URL: url,
      PACT_AGENT_TOKEN: 'secret-token',
    },
  });
  child = proc;
  let stdout = '';
  proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve));

  const until = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!predicate()) throw new Error(`timed out waiting for ${what}\n--- stdout ---\n${stdout}`);
  };
  const prompts = () => stdout.split('> ').length - 1;
  return {
    hooks,
    exited,
    output: () => stdout,
    types: () => hooks.map((h) => h.body.type),
    waitFor: (text: string) => until(() => stdout.includes(text), JSON.stringify(text)),
    waitForHook: (type: string) => until(() => hooks.some((h) => h.body.type === type), type),
    waitForPrompt: (count: number) => until(() => prompts() >= count, `prompt #${String(count)}`),
    send: (line: string) => proc.stdin.write(`${line}\n`),
  };
}

describe('fake CLI', () => {
  it('shows a prompt, runs a turn and reports it through the hooks', async () => {
    const fake = await runFake('prompt-then-done', { args: ['--session-id', 'abc-123'] });
    await fake.waitFor('Session abc-123');
    await fake.waitForPrompt(1);
    fake.send('Ajoute un test');
    await fake.waitForPrompt(2);
    expect(fake.output()).toContain('Travail en cours\nTerminé\n');
    await fake.waitForHook('turn-finished');
    expect(fake.hooks.map((h) => h.body)).toEqual([
      { type: 'session-started', sessionId: 'abc-123' },
      { type: 'prompt-submitted', prompt: 'Ajoute un test' },
      { type: 'turn-finished' },
    ]);
    expect(fake.hooks.every((h) => h.headers['x-pact-token'] === 'secret-token')).toBe(true);
  });

  it('resumes an existing session', async () => {
    const fake = await runFake('prompt-then-done', { args: ['--resume', 'abc-123'] });
    await fake.waitFor('Session reprise abc-123');
    await fake.waitForHook('session-started');
    expect(fake.hooks[0]?.body).toEqual({ type: 'session-started', sessionId: 'abc-123' });
  });

  it.each([
    ['allow', 'Autorisé'],
    ['deny', 'Refusé'],
  ])('waits for the permission answer (%s) before finishing the turn', async (answer, echo) => {
    const fake = await runFake('ask-permission');
    await fake.waitForPrompt(1);
    fake.send('Nettoie');
    await fake.waitFor('? Exécuter : rm fichier.txt (allow/deny)');
    await fake.waitForHook('awaiting-answer');
    expect(fake.hooks.at(-1)?.body).toEqual({
      type: 'awaiting-answer',
      summary: 'rm fichier.txt',
      ruleKey: 'Bash(rm fichier.txt)',
    });

    fake.send('something else');
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.types()).not.toContain('turn-finished');

    fake.send(answer);
    await fake.waitFor(echo);
    await fake.waitForHook('turn-finished');
  });

  it('crashes with exit code 1', async () => {
    const fake = await runFake('crash-exit-1');
    await fake.waitForPrompt(1);
    fake.send('go');
    expect(await fake.exited).toBe(1);
    expect(fake.types()).toContain('failed');
  });

  it('exits on a rate limit, reporting the reset time', async () => {
    const fake = await runFake('rate-limit');
    await fake.waitForPrompt(1);
    fake.send('go');
    expect(await fake.exited).toBe(1);
    expect(fake.output()).toContain('Resets at 2030-01-01T09:30:00.000Z');
    expect(fake.hooks.at(-1)?.body).toMatchObject({
      type: 'failed',
      kind: 'rate-limit',
      resetAt: '2030-01-01T09:30:00.000Z',
    });
  });

  it('stays alive on a rate limit until told to continue', async () => {
    const fake = await runFake('rate-limit-alive');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('failed');
    fake.send('continue');
    await fake.waitFor('Reprise');
    await fake.waitForHook('turn-finished');
  });

  it('resumes on its own after a rate limit, like quota_auto_resume_fired', async () => {
    const fake = await runFake('rate-limit-native-resume');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('failed');
    await fake.waitForHook('prompt-submitted');
    await fake.waitFor('Reprise');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('quota_auto_resume_fired');
  });

  it('renames its branch', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-b', 'agent/fake-1');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init');

    const fake = await runFake('rename-branch', { cwd: tmp });
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('turn-finished');
    expect(git('branch', '--show-current').trim()).toBe('feature/login');
  });

  it('bursts output quickly', async () => {
    const fake = await runFake('burst-output');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitFor('burst 2000\n');
  });
});
