import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { ReviewService } from '../../../src/main/review/review-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import { ipcEvents, type IpcEvent } from '../../../src/shared/ipc';
import type { Agent, Role, Workspace } from '../../../src/shared/model';
import type { ReviewSnapshot } from '../../../src/shared/review';

// fix-todo-diff-notifications — the base of the changes is origin/<main>, not the local main,
// which may lag (162 commits once); `.pact/` is no change to review; the orchestrator has none.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const gitService = new GitService({ env: gitEnv });

const AGENT_ID = '00000000-0000-4000-8000-000000000001';

let root: string;
let repo: string;
let origin: string;
let other: string;
let worktree: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let service: ReviewService;
let changed: ReviewSnapshot[];
let pending: IpcEvent<'review:pending'>[];

const agent = (role: Role | null = null): Agent => ({
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
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'done',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role,
  effort: null,
});

const useAgent = (role: Role | null = null) =>
  workspaces.update(workspace.id, (ws) => ({ ...ws, agents: [agent(role)] }));

/** Another clone pushes `count` commits to origin/main. */
const pushFromElsewhere = (count: number) => {
  for (let i = 1; i <= count; i++) {
    execFileSync('git', ['pull', '-q', 'origin', 'main'], { cwd: other, env: gitEnv });
    execFileSync('sh', ['-c', `echo ${String(i)} > lag-${String(i)}-${String(Date.now())}.txt`], {
      cwd: other,
    });
    git(other, 'add', '.');
    git(other, 'commit', '-m', `lag ${String(i)}`);
    git(other, 'push', '-q', 'origin', 'main');
  }
};

const waitFor = async (check: () => boolean, what: string, timeoutMs = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const paths = (snapshot: ReviewSnapshot | undefined) => snapshot?.files.map((f) => f.path);

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-review-origin-')));
  repo = join(root, 'repo');
  origin = join(root, 'origin.git');
  other = join(root, 'other');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'un\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, other);
  worktree = join(repo, '.worktrees', 'claude-code-1');

  stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: gitService, stores });
  workspace = await workspaces.open(repo);
  changed = [];
  pending = [];
  service = new ReviewService({
    git: gitService,
    workspaces,
    onChanged: (snapshot) => changed.push(snapshot),
    onPending: (event) => pending.push(event),
    debounceMs: 20,
    safetyMs: 100,
  });
});

afterEach(async () => {
  service.dispose();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the base of the changes is origin/main', () => {
  it('ignores a local main that lags behind origin/main', async () => {
    pushFromElsewhere(3);
    git(repo, 'fetch', '-q', 'origin', 'main');
    // The local main stays at « initial »: the agent starts from the commits of origin.
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'origin/main');
    await useAgent();
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    const snapshot = await service.open(AGENT_ID);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(git(repo, 'rev-parse', 'origin/main'));
    expect(snapshot.base).toBe(git(repo, 'rev-parse', 'origin/main'));
    expect(paths(snapshot)).toEqual(['b.txt']);
  });

  it('lists nothing for an agent with no change of its own while the local main lags', async () => {
    pushFromElsewhere(2);
    git(repo, 'fetch', '-q', 'origin', 'main');
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'origin/main');
    await useAgent('orchestrator');
    expect(paths(await service.open(AGENT_ID))).toEqual([]);
  });

  it('keeps the local main as the base without an origin/main', async () => {
    git(repo, 'remote', 'remove', 'origin');
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
    await useAgent();
    await writeFile(join(repo, 'later.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'main moves on');
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    const snapshot = await service.open(AGENT_ID);
    expect(snapshot.base).toBe(git(repo, 'merge-base', 'main', 'agent/claude-code-1'));
    expect(paths(snapshot)).toEqual(['b.txt']);
  });

  it('keeps the local main as the base with an origin that has no main yet', async () => {
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
    await useAgent();
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    const snapshot = await service.open(AGENT_ID);
    expect(snapshot.base).toBe(git(repo, 'rev-parse', 'main'));
    expect(paths(snapshot)).toEqual(['b.txt']);
  });

  it('recalculates an open review when origin/main moves, with no action of the user', async () => {
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
    await useAgent();
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'agent work');
    expect(paths(await service.open(AGENT_ID))).toEqual(['b.txt']);
    // The agent's work reaches origin/main, outside of PACT.
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(worktree, 'rev-parse', 'HEAD'));
    await waitFor(() => paths(changed.at(-1))?.length === 0, 'the review is still not updated');
  });
});

describe('GitService.fetchOrigin — only the main branch, nothing local touched', () => {
  beforeEach(async () => {
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
    await useAgent();
  });

  it('updates origin/main only: no local branch, no HEAD, no worktree file moves', async () => {
    pushFromElsewhere(2);
    git(other, 'push', '-q', 'origin', 'main:refs/heads/autre');
    const mainBefore = git(repo, 'rev-parse', 'main');
    const headBefore = git(worktree, 'rev-parse', 'HEAD');
    const advanced = git(other, 'rev-parse', 'HEAD');
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    expect(await gitService.fetchOrigin(repo, 'main')).toBe(true);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(advanced);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(worktree, 'status', '--porcelain')).toBe('?? b.txt');
    expect(git(repo, 'for-each-ref', 'refs/remotes/origin/autre')).toBe('');
  });

  it('gives up quietly when the network is down, keeping the last origin/main known', async () => {
    const known = git(repo, 'rev-parse', 'origin/main');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    expect(await gitService.fetchOrigin(repo, 'main')).toBe(false);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(known);
  });
});

describe('what is no change to review', () => {
  beforeEach(() => {
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
  });

  it('leaves out the working files of PACT under .pact/', async () => {
    await useAgent();
    await mkdir(join(worktree, '.pact', 'issues'), { recursive: true });
    await writeFile(join(worktree, '.pact', 'issues', 'x.md'), '# x\n');
    await writeFile(join(worktree, '.pact', 'recap.md'), '# recap\n');
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    expect(paths(await service.open(AGENT_ID))).toEqual(['b.txt']);
  });

  it('lists no agent to review whose only changes are under .pact/', async () => {
    await useAgent();
    await mkdir(join(worktree, '.pact'), { recursive: true });
    await writeFile(join(worktree, '.pact', 'recap.md'), '# recap\n');
    expect(await service.updatePending(workspace.id)).toEqual([]);
    expect(pending.at(-1)?.agentIds).toEqual([]);
  });

  it('lists the agent to review with its number of files, the .pact/ ones not counted', async () => {
    await useAgent();
    await mkdir(join(worktree, '.pact'), { recursive: true });
    await writeFile(join(worktree, '.pact', 'recap.md'), '# recap\n');
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    await writeFile(join(worktree, 'c.txt'), 'c\n');
    expect(await service.updatePending(workspace.id)).toEqual([AGENT_ID]);
    expect(pending.at(-1)).toMatchObject({
      workspaceId: workspace.id,
      agentIds: [AGENT_ID],
      files: { [AGENT_ID]: 2 },
    });
  });

  it('lists the orchestrator to review never, even with changed files', async () => {
    await useAgent('orchestrator');
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    expect(await service.updatePending(workspace.id)).toEqual([]);
    expect(pending.at(-1)?.agentIds).toEqual([]);
    // Its changes stay readable in its own view.
    expect(paths(await service.open(AGENT_ID))).toEqual(['b.txt']);
  });
});

describe('the review:pending payload', () => {
  it('still reads an old payload without the number of files', () => {
    const old = { workspaceId: 'w1', agentIds: ['00000000-0000-4000-8000-000000000001'] };
    expect(ipcEvents['review:pending'].safeParse(old).success).toBe(true);
  });
});
