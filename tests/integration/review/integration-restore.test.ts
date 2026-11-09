import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { IntegrationService } from '../../../src/main/review/integration-service';
import type { Agent, Workspace } from '../../../src/shared/model';
import type { Integration } from '../../../src/shared/review';
import {
  createDeliveryHarness,
  git as hgit,
  type DeliveryHarness,
} from '../delivery/delivery-harness';

// 008 T047 — US6 sc.2, SC-005, FR-025, research R19: a conflict half resolved survives a restart of
// PACT, and the local request waits for the issue of the integration, not for its first state.
//
// RED until T051: `IntegrationService` keeps its `Pending` in a Map only, so a new service finds
// nothing; `restore()` does not exist; nothing is written in `<integrationsDir>/<id>.json`.
//
// ASSUMED API (R19 fixes the file and the name `restore()`; the rest is mine, listed in the report):
//   - `<integrationsDir>/<id>.json` is written when the integration stops on conflicts and at each
//     change (a resolution, a state), and removed at `integrated` and `cancelled` only. Its format is
//     the dev's: the tests read it as text, never by its fields;
//   - `restore(): Promise<Integration[]>` reads those files at the start of the app and returns the
//     integrations it took up again (state `conflicted`, conflicts with their resolutions, `request`
//     fields such as `requestId` kept); the new service then resolves, finishes or cancels them as it
//     would have before the restart;
//   - the id of an integration does not change with the restart.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const AGENT_ID = '00000000-0000-4000-8000-000000000001';

let root: string;
let repo: string;
let worktree: string;
let userData: string;
let workspace: Workspace;
let states: Integration[];
let closed: string[];
let services: IntegrationService[];

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};
const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};
const agent = (): Agent => ({
  id: AGENT_ID,
  workspaceId: workspace.id,
  position: 1,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: 'agent/claude-code-1',
  worktreePath: worktree,
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: 'Ajoute le total',
  alwaysAllowRules: [],
  state: 'done',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
});

/** A service as the app creates it at its start: nothing in memory, the same disk. */
const createService = () => {
  const service = new IntegrationService({
    git: new GitService({ env: gitEnv }),
    workspaces: { list: () => [workspace] },
    agents: {
      close: (id) => {
        closed.push(id);
        return Promise.resolve();
      },
    },
    prompts: { sendPrompt: () => Promise.resolve() },
    integrationsDir: join(userData, 'integrations'),
    conflictsDir: join(userData, 'conflicts'),
    onState: (integration) => states.push(integration),
  });
  services.push(service);
  return service;
};

/** `restore()` as the app calls it; its absence is the failure the tests show. */
const restore = async (service: IntegrationService): Promise<Integration[]> => {
  const restorable = service as unknown as { restore?: () => Promise<Integration[]> };
  expect(typeof restorable.restore, 'IntegrationService.restore() (T051, R19)').toBe('function');
  return (restorable.restore as () => Promise<Integration[]>).call(service);
};

const start = (service: IntegrationService, extra: { requestId?: string } = {}) =>
  service.start({
    agentId: AGENT_ID,
    mode: 'squash',
    message: 'Ajoute le total',
    after: { closeTile: true, removeWorktree: false },
    ...extra,
  });

const savedFile = (id: string) => join(userData, 'integrations', `${id}.json`);
const readSaved = (id: string) => readFile(savedFile(id), 'utf8');
const folder = async () =>
  (await readdir(join(userData, 'integrations')).catch(() => [])).filter((n) =>
    n.endsWith('.json'),
  );

/** main and the agent change the same line of a.txt and of b.txt: two files in conflict. */
const twoConflicts = async () => {
  await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
  await write(join(repo, 'b.txt'), 'b de main\n');
  commitAll(repo, 'Ajout SSO');
  await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
  await write(join(worktree, 'b.txt'), 'b de l’agent\n');
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-restore-')));
  repo = join(root, 'Mes Projets', 'Développement');
  userData = join(root, 'userData');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await write(join(repo, '.git', 'info', 'exclude'), '/.worktrees/\n');
  await write(join(repo, 'a.txt'), 'un\ndeux\ntrois\n');
  await write(join(repo, 'b.txt'), 'b\n');
  commitAll(repo, 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/claude-code-1', worktree, 'main');
  workspace = {
    id: '00000000-0000-4000-8000-0000000000aa',
    path: repo,
    mainBranch: 'main',
    agents: [],
  } as unknown as Workspace;
  workspace = { ...workspace, agents: [agent()] };
  states = [];
  closed = [];
  services = [];
});

afterEach(async () => {
  for (const service of services) service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Given an integration stopped on conflicts (sc.2, R19)', () => {
  it('When it stops, Then its state is on the disk in <integrationsDir>/<id>.json, and it follows each resolution', async () => {
    await twoConflicts();
    const service = createService();

    const { id } = await start(service);

    const first = await readSaved(id).catch(() => '');
    expect(first, 'the file of the integration').not.toBe('');
    expect(first).toContain(id);
    await service.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    const second = await readSaved(id);
    expect(second).not.toBe(first);
  });

  it('When PACT starts again with a new service, Then the conflicts and the resolutions are there (sc.2)', async () => {
    await twoConflicts();
    const before = createService();
    const { id } = await start(before);
    await before.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    before.dispose();

    const after = createService();
    const restored = await restore(after);

    expect(restored.map((i) => i.id)).toEqual([id]);
    const [integration] = restored;
    expect(integration?.state).toBe('conflicted');
    expect(integration?.agentId).toBe(AGENT_ID);
    expect(integration?.conflicts.map((f) => [f.path, f.resolved])).toEqual([
      ['a.txt', true],
      ['b.txt', false],
    ]);
    expect(integration?.conflicts[0]?.hunks[0]?.resolution).toBe('agent');
    expect(integration?.conflicts[1]?.hunks[0]?.resolution).toBeNull();
  });

  it('When the rest is resolved and finished after the restart, Then main has BOTH resolutions, the one made before and the one made after', async () => {
    await twoConflicts();
    const before = createService();
    const { id } = await start(before);
    await before.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    before.dispose();

    const after = createService();
    await restore(after);
    // The restored file was not forgotten: finishing now is refused until b.txt is resolved.
    await expect(after.finish(id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await after.resolve(id, { path: 'b.txt', hunk: 0, choice: 'main' });
    const done = await after.finish(id);

    expect(done.state).toBe('integrated');
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDeux de l’agent\ntrois');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b de main');
  });

  it('When it was started for a request, Then the restored one still carries it, and what comes after the merge follows (R20)', async () => {
    await twoConflicts();
    const requestId = '00000000-0000-4000-8000-0000000000bb';
    const before = createService();
    const { id } = await start(before, { requestId });
    before.dispose();

    const after = createService();
    const [restored] = await restore(after);
    await after.resolve(id, { path: 'a.txt', hunk: 0, choice: 'main' });
    await after.resolve(id, { path: 'b.txt', hunk: 0, choice: 'main' });
    await after.finish(id);

    expect(restored?.requestId).toBe(requestId);
    expect(states.at(-1)).toMatchObject({ id, state: 'integrated', requestId });
    // `after.closeTile` was asked by the request: the tile of the agent closes.
    expect(closed).toEqual([AGENT_ID]);
  });
});

describe('Given the file of an integration (R19: removed at the end only)', () => {
  it('When PACT restarts and the user does nothing, Then the file stays, however many times it starts again', async () => {
    await twoConflicts();
    const first = createService();
    const { id } = await start(first);
    first.dispose();

    const second = createService();
    await restore(second);
    second.dispose();
    const third = createService();
    const restored = await restore(third);

    expect(restored.map((i) => i.id)).toEqual([id]);
    expect(await folder()).toEqual([`${id}.json`]);
  });

  it('When it is integrated, Then the file goes with it, and a restart finds nothing', async () => {
    await twoConflicts();
    const before = createService();
    const { id } = await start(before);
    await before.resolve(id, { path: 'a.txt', hunk: 0, choice: 'main' });
    await before.resolve(id, { path: 'b.txt', hunk: 0, choice: 'main' });
    expect(await folder()).toEqual([`${id}.json`]);
    await before.finish(id);
    before.dispose();

    expect(await folder()).toEqual([]);
    expect(await restore(createService())).toEqual([]);
  });

  it('When it is cancelled, Then the file goes with it, and a restart finds nothing', async () => {
    await twoConflicts();
    const before = createService();
    const { id } = await start(before);
    await before.cancel(id);
    before.dispose();

    expect(await folder()).toEqual([]);
    expect(await restore(createService())).toEqual([]);
  });

  it('When it is cancelled after a restart, Then nothing was written in main and the file goes', async () => {
    await twoConflicts();
    const mainBefore = git(repo, 'rev-parse', 'main');
    const before = createService();
    const { id } = await start(before);
    before.dispose();

    const after = createService();
    await restore(after);
    await after.cancel(id);

    expect(states.at(-1)).toMatchObject({ id, state: 'cancelled' });
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await folder()).toEqual([]);
  });
});

// The local request: while the integration is on conflicts, the request is `merging` and stays so,
// through any number of restarts, until the integration ends (R19, sc.2 « la demande locale reste
// jusqu'à l'issue »). RED for the same reason: the restart finds no integration to follow.
describe('Given a local request whose merge stopped on conflicts', () => {
  let h: DeliveryHarness;

  afterEach(async () => {
    await h.dispose();
  });

  /** A dev accepted, a request without remote, « Fusionner » clicked, main having moved on the same line. */
  async function conflicted() {
    h = await createDeliveryHarness({ remote: false });
    const { dev, tester } = await h.team('a', { accept: false });
    // The dev and main change the first line of README.md: one file, one hunk.
    await h.commit(dev, { 'README.md': '# test de l’agent\n' }, 'readme');
    await h.acceptLoop(dev, tester);
    const request = await h.request(dev.id);
    await writeFile(join(h.repo, 'README.md'), '# test de main\n');
    hgit(h.repo, 'add', '-A');
    hgit(h.repo, 'commit', '-q', '-m', 'main moves');
    await h.delivery.decide({
      deliveryId: request.id,
      decision: 'validate',
      head: hgit(dev.worktreePath, 'rev-parse', 'HEAD'),
    });
    const integrationId = await waitForConflict();
    return { dev, request, integrationId };
  }
  const waitForConflict = async () => {
    await h.waitFor(
      () => h.integrations.some((i) => i.state === 'conflicted'),
      'the merge did not stop on conflicts',
    );
    return (h.integrations.findLast((i) => i.state === 'conflicted') as Integration).id;
  };

  it('When PACT restarts, Then the request is still waiting for the issue, not dropped, not back to the user, not merged', async () => {
    const { request } = await conflicted();
    expect(h.deliveryOf(request.id).state).toBe('merging');

    await h.restart();

    const kept = h.deliveryOf(request.id);
    expect(kept.state).toBe('merging');
    expect(kept.channel).toBe('local');
    expect(h.deliveryMessages().map((m) => m.delivery?.outcome)).not.toContain('merged');
  });

  it('When the restored conflict is resolved and finished, Then the request ends merged, once', async () => {
    const { request, integrationId } = await conflicted();
    await h.restart();

    await h.integration.resolve(integrationId, { path: 'README.md', hunk: 0, choice: 'agent' });
    await h.integration.finish(integrationId);

    const done = await h.until(request.id, ['merged'], 8_000);
    expect(done.state).toBe('merged');
    expect(h.deliveryMessages().filter((m) => m.delivery?.outcome === 'merged')).toHaveLength(1);
    expect(hgit(h.repo, 'show', 'main:README.md')).toBe('# test de l’agent');
  });

  it('When the restored conflict is cancelled, Then the request goes back to the user with the reason', async () => {
    const { request, integrationId } = await conflicted();
    await h.restart();

    await h.integration.cancel(integrationId);

    const back = await h.until(request.id, ['reviewing'], 8_000);
    expect(back.state).toBe('reviewing');
    expect(h.deliveryMessages().map((m) => m.delivery?.outcome)).toContain('merge-failed');
  });
});
