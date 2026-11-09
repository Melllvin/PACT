import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { IntegrationService } from '../../../src/main/review/integration-service';
import type { Agent, Workspace } from '../../../src/shared/model';

// 008 R19 — the edges of the file of an integration: nothing to restore, files that are not ours,
// an agent that is gone, a disk that refuses the write. The main cases are in integration-restore.test.ts.

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const AGENT_ID = '00000000-0000-4000-8000-000000000001';

let root: string;
let repo: string;
let worktree: string;
let userData: string;
let agents: Agent[];
let services: IntegrationService[];

const create = (integrationsDir = join(userData, 'integrations')) => {
  const service = new IntegrationService({
    git: new GitService({ env }),
    workspaces: {
      list: () => [{ id: 'ws', path: repo, mainBranch: 'main', agents } as unknown as Workspace],
    },
    agents: { close: () => Promise.resolve() },
    integrationsDir,
  });
  services.push(service);
  return service;
};
const start = (service: IntegrationService) =>
  service.start({
    agentId: AGENT_ID,
    mode: 'squash',
    message: 'm',
    after: { closeTile: false, removeWorktree: false },
  });
const files = async () =>
  (await readdir(join(userData, 'integrations')).catch(() => [])).filter((n) =>
    n.endsWith('.json'),
  );

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-restore-edge-')));
  repo = join(root, 'repo');
  userData = join(root, 'userData');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'un\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  worktree = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/x', worktree, 'main');
  await writeFile(join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'main');
  await writeFile(join(worktree, 'a.txt'), 'agent\n');
  agents = [
    { id: AGENT_ID, state: 'done', worktreePath: worktree, branch: 'agent/x' } as unknown as Agent,
  ];
  services = [];
});

afterEach(async () => {
  for (const service of services) service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('IntegrationService.restore() edges (R19)', () => {
  it('finds nothing at the first start, when the folder does not exist', async () => {
    expect(await create().restore()).toEqual([]);
  });

  it('leaves alone a file that is not the file of an integration, or is unreadable', async () => {
    const dir = join(userData, 'integrations');
    await mkdir(dir, { recursive: true });
    const id = '00000000-0000-4000-8000-0000000000cc';
    await writeFile(join(dir, 'notes.json'), '{}');
    await writeFile(join(dir, `${id}.json`), 'not json');
    await writeFile(join(dir, '00000000-0000-4000-8000-0000000000dd.json'), 'null');
    await writeFile(
      join(dir, '00000000-0000-4000-8000-0000000000ee.json'),
      JSON.stringify({ integration: { id: 'another' } }),
    );

    expect(await create().restore()).toEqual([]);
    expect((await readdir(dir)).sort()).toHaveLength(4);
  });

  it('takes an integration up once, however many times restore() is called', async () => {
    const first = create();
    const { id } = await start(first);
    first.dispose();

    const second = create();
    expect((await second.restore()).map((i) => i.id)).toEqual([id]);
    expect(await second.restore()).toEqual([]);
  });

  it('forgets an integration whose agent is gone: its file is removed', async () => {
    const first = create();
    await start(first);
    first.dispose();
    agents = [];

    expect(await create().restore()).toEqual([]);
    expect(await files()).toEqual([]);
  });

  it('puts an integration that was waiting for its agent back on conflicts', async () => {
    const first = create();
    const { id } = await start(first);
    const saved = JSON.parse(
      await readFile(join(userData, 'integrations', `${id}.json`), 'utf8'),
    ) as { integration: { state: string } };
    saved.integration.state = 'waiting-agent';
    await writeFile(join(userData, 'integrations', `${id}.json`), JSON.stringify(saved));
    first.dispose();

    const [restored] = await create().restore();
    expect(restored?.state).toBe('conflicted');
  });
});

describe('The file of an integration when the disk refuses (best effort)', () => {
  it('does not stop the integration: it stops on its conflicts, in memory', async () => {
    // The folder of the integrations is a file: nothing can be written in it.
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'integrations'), 'a file');

    const service = create();
    const integration = await start(service);

    expect(integration.state).toBe('conflicted');
    await service.cancel(integration.id);
  });
});
