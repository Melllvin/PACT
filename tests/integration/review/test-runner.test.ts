import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TestRunner,
  detectTestCommandIn,
  type TestTarget,
} from '../../../src/main/review/test-runner';
import type { TestRun } from '../../../src/shared/review';

// 002 T028 — the tests of an agent run in its worktree, outside any terminal (research R8).

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const TREE = 'a'.repeat(40);

let root: string;
let target: TestTarget;
let updates: TestRun[];
let runner: TestRunner;

const shellEnv = () => Promise.resolve({ ...process.env } as Record<string, string>);
const node = (script: string) => `node -e "${script}"`;

const finished = async (agentId = AGENT_ID) => {
  const start = Date.now();
  for (;;) {
    const last = updates.filter((u) => u.agentId === agentId).at(-1);
    if (last && last.status !== 'running') return last;
    if (Date.now() - start > 10_000) throw new Error('the tests never finished');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => Promise<boolean> | boolean, what: string) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 10_000) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-tests-')));
  const cwd = join(root, 'Mes Projets', 'Développement');
  await mkdir(cwd, { recursive: true });
  target = { agentId: AGENT_ID, cwd, port: 3007 };
  updates = [];
  runner = new TestRunner({
    env: shellEnv,
    onUpdate: (run) => updates.push(run),
  });
});

afterEach(async () => {
  runner.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('TestRunner (R8)', () => {
  it('runs the command in the worktree with the port of the agent, and says it passed', async () => {
    const command = node(
      "console.log(process.cwd()); console.log('PORT=' + process.env.PORT); console.log('Tests  24 passed (24)')",
    );
    const running = await runner.run(target, command, TREE);
    expect(running).toMatchObject({ agentId: AGENT_ID, command, tree: TREE, status: 'running' });
    const run = await finished();
    expect(run).toMatchObject({ status: 'passed', passedCount: 24, tree: TREE });
    expect(run.outputTail).toContain(target.cwd);
    expect(run.outputTail).toContain('PORT=3007');
    expect(updates[0]?.status).toBe('running');
    expect(runner.latest(AGENT_ID)).toEqual(run);
  });

  it('says it failed on a non-zero exit, error output included', async () => {
    await runner.run(target, node("console.error('2 tests en échec'); process.exit(3)"), TREE);
    expect(await finished()).toMatchObject({
      status: 'failed',
      passedCount: null,
      outputTail: expect.stringContaining('2 tests en échec') as unknown,
    });
  });

  it('keeps the last 200 lines of the output', async () => {
    await runner.run(
      target,
      node("for (let i = 1; i <= 250; i++) console.log('ligne ' + i)"),
      TREE,
    );
    const lines = (await finished()).outputTail.trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('ligne 51');
  });

  it('runs one at a time per agent: a second request gets the run in progress', async () => {
    const first = await runner.run(target, node('setTimeout(() => {}, 300)'), TREE);
    const second = await runner.run(target, node("console.log('autre')"), 'b'.repeat(40));
    expect(second).toEqual(first);
    expect(await finished()).toMatchObject({ status: 'passed', tree: TREE });
  });

  it('stops after the delay and says so', async () => {
    runner.dispose();
    runner = new TestRunner({
      env: shellEnv,
      onUpdate: (run) => updates.push(run),
      timeoutMs: 300,
    });
    await runner.run(target, node('setTimeout(() => {}, 60000)'), TREE);
    expect(await finished()).toMatchObject({ status: 'timeout' });
  });

  it('cancels a run, the processes it started included', async () => {
    const pidFile = join(target.cwd, 'pid');
    // `cd .` keeps the shell between PACT and node, as `npm test` would.
    const command = `cd . && ${node(
      "require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 60000)",
    )}`;
    await runner.run(target, command, TREE);
    await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', 'no pid');
    const pid = Number(await readFile(pidFile, 'utf8'));
    runner.cancel(AGENT_ID);
    expect(await finished()).toMatchObject({ status: 'cancelled' });
    await waitFor(() => !alive(pid), 'the test process survived');
    runner.cancel(AGENT_ID);
    expect(updates.filter((u) => u.status === 'cancelled')).toHaveLength(1);
  });

  it('stops what runs when PACT quits, with no result to show', async () => {
    const pidFile = join(target.cwd, 'pid');
    await runner.run(
      target,
      node("require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 60000)"),
      TREE,
    );
    await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', 'no pid');
    const pid = Number(await readFile(pidFile, 'utf8'));
    runner.dispose();
    await waitFor(() => !alive(pid), 'the test process survived');
    expect(updates.map((u) => u.status)).toEqual(['running']);
  });

  it('runs again only when no result is for the tree shown, else announces that result', async () => {
    await runner.ensure(target, node("console.log('Tests  1 passed (1)')"), TREE);
    const result = await finished();
    const count = updates.length;
    expect(await runner.ensure(target, node("console.log('x')"), TREE)).toBeUndefined();
    // The window may have missed it: announced again, not run again.
    expect(updates.slice(count)).toEqual([result]);
    const next = await runner.ensure(target, node("console.log('x')"), 'b'.repeat(40));
    expect(next).toMatchObject({ status: 'running', tree: 'b'.repeat(40) });
    await finished();
  });

  it('says it failed when the command cannot start', async () => {
    target = { ...target, cwd: join(root, 'absent') };
    await runner.run(target, node("console.log('x')"), TREE);
    expect(await finished()).toMatchObject({ status: 'failed' });
  });
});

describe('detectTestCommandIn (R8)', () => {
  it('reads package.json and the lockfile of the worktree', async () => {
    expect(await detectTestCommandIn(target.cwd)).toBeNull();
    await writeFile(
      join(target.cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );
    expect(await detectTestCommandIn(target.cwd)).toBe('npm test');
    await writeFile(join(target.cwd, 'yarn.lock'), '');
    expect(await detectTestCommandIn(target.cwd)).toBe('yarn test');
  });
});
