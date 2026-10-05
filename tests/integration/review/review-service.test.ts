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
import type { IpcEvent } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import type { ReviewSnapshot, TestRun } from '../../../src/shared/review';

// 002 T016 — the review of an agent's worktree, followed while it changes (research R1–R3, R9).
// T037 — comments and instructions sent to the agent from the review (R7, FR-012…FR-015).

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
let worktree: string;
let userData: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let service: ReviewService;
let changed: ReviewSnapshot[];
let pending: IpcEvent<'review:pending'>[];
/** What `sendPrompt` queued for the agent, in order. */
let typed: { id: string; text: string }[];
let latestRun: TestRun | null;

const agent = (worktreePath: string, state: AgentState = 'done'): Agent => ({
  id: AGENT_ID,
  workspaceId: workspace.id,
  position: 1,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: 'agent/claude-code-1',
  worktreePath,
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: 'Ajoute le total',
  alwaysAllowRules: [],
  state,
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
});

const createService = (options: Partial<ConstructorParameters<typeof ReviewService>[0]> = {}) =>
  new ReviewService({
    git: gitService,
    workspaces,
    onChanged: (snapshot) => changed.push(snapshot),
    onPending: (event) => pending.push(event),
    agents: {
      sendPrompt: (id, text) => {
        typed.push({ id, text });
        return Promise.resolve();
      },
    },
    tests: { latest: () => latestRun },
    ...options,
  });

const setState = (state: AgentState) =>
  workspaces.update(workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => ({ ...a, state })),
  }));

const waitFor = async (check: () => boolean, what: string, timeoutMs = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const paths = (snapshot: ReviewSnapshot | undefined) => snapshot?.files.map((f) => f.path);

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-review-service-')));
  repo = join(root, 'Mes Projets', 'Développement');
  userData = join(root, 'userData');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'un\ndeux\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');

  stores = openStores(userData);
  workspaces = new WorkspaceService({ git: gitService, stores });
  workspace = await workspaces.open(repo);
  await workspaces.update(workspace.id, (ws) => ({ ...ws, agents: [agent(worktree)] }));
  changed = [];
  pending = [];
  typed = [];
  latestRun = null;
  service = createService();
});

afterEach(async () => {
  service.dispose();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('ReviewService.open', () => {
  it('returns the snapshot of the worktree against main', async () => {
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    await writeFile(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const snapshot = await service.open(AGENT_ID);
    expect(snapshot).toMatchObject({
      agentId: AGENT_ID,
      base: git(repo, 'rev-parse', 'main'),
      mainHead: git(repo, 'rev-parse', 'main'),
      branch: 'agent/claude-code-1',
      added: 3,
      removed: 1,
      newSinceSeen: null,
      missing: false,
      testCommand: null,
    });
    expect(paths(snapshot)).toEqual(['a.txt', 'b.txt']);
    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses an unknown agent', async () => {
    await expect(service.open('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('says the worktree is missing, so only « Abandonner » is left', async () => {
    await rm(worktree, { recursive: true, force: true });
    expect(await service.open(AGENT_ID)).toMatchObject({
      missing: true,
      files: [],
      testCommand: null,
    });
  });
});

describe('ReviewService following the worktree (R3)', () => {
  it('announces a change written in the worktree in under 3 s (SC-006)', async () => {
    await service.open(AGENT_ID);
    await writeFile(join(worktree, 'nouveau.ts'), 'export {};\n');
    await waitFor(
      () => paths(changed.at(-1))?.includes('nouveau.ts') === true,
      'no review:changed for nouveau.ts',
    );
  });

  it('catches up a missed event with the safety net', async () => {
    service.dispose();
    service = createService({ watch: () => () => undefined, safetyMs: 200 });
    await service.open(AGENT_ID);
    await writeFile(join(worktree, 'rate.ts'), 'export {};\n');
    await waitFor(() => paths(changed.at(-1))?.includes('rate.ts') === true, 'safety net missed');
  });

  it('stops following once closed', async () => {
    service.dispose();
    service = createService({ safetyMs: 200 });
    await service.open(AGENT_ID);
    service.close(AGENT_ID);
    await writeFile(join(worktree, 'tard.ts'), 'export {};\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(changed.some((s) => paths(s)?.includes('tard.ts'))).toBe(false);
  });

  it('does not follow a review closed while it was opening', async () => {
    service.dispose();
    service = createService({ safetyMs: 200 });
    const opening = service.open(AGENT_ID);
    service.close(AGENT_ID);
    await opening;
    await writeFile(join(worktree, 'trop-tard.ts'), 'export {};\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(changed).toEqual([]);
  });

  it('gives the diff of one file of the current snapshot', async () => {
    await writeFile(join(worktree, 'a.txt'), 'un\nDEUX\n');
    await service.open(AGENT_ID);
    const diff = await service.fileDiff(AGENT_ID, 'a.txt');
    expect(diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context')).toEqual([
      { kind: 'del', oldNo: 2, newNo: null, text: 'deux' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'DEUX' },
    ]);
  });
});

describe('ReviewService « vu » (FR-009, FR-011)', () => {
  it('remembers the blob seen, and a seen file changed again counts as new changes', async () => {
    await writeFile(join(worktree, 'a.txt'), 'un\nDEUX\n');
    const snapshot = await service.open(AGENT_ID);
    const blob = snapshot.files[0]?.blob;
    await service.setSeen(AGENT_ID, 'a.txt', true);
    expect(workspaces.get(workspace.id)?.agents[0]?.review.seen).toEqual({ 'a.txt': blob });

    await writeFile(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await waitFor(() => changed.at(-1)?.newSinceSeen !== null, 'no new changes since seen');
    expect(changed.at(-1)?.newSinceSeen).toEqual({ added: 1, removed: 0 });
    expect(changed.at(-1)?.files[0]?.blob).not.toBe(blob);

    await service.setSeen(AGENT_ID, 'a.txt', false);
    expect(workspaces.get(workspace.id)?.agents[0]?.review.seen).toEqual({});
  });

  it('marks a deleted file seen too, with the null id since it has no content', async () => {
    await rm(join(worktree, 'a.txt'));
    await service.open(AGENT_ID);
    await service.setSeen(AGENT_ID, 'a.txt', true);
    expect(workspaces.get(workspace.id)?.agents[0]?.review.seen).toEqual({
      'a.txt': '0'.repeat(40),
    });
    expect((await service.open(AGENT_ID)).newSinceSeen).toBeNull();
  });

  it('keeps what was seen after a restart', async () => {
    await writeFile(join(worktree, 'a.txt'), 'un\nDEUX\n');
    await service.open(AGENT_ID);
    await service.setSeen(AGENT_ID, 'a.txt', true);
    const reloaded = await openStores(userData).workspace(workspace.id).read();
    expect(Object.keys(reloaded?.agents[0]?.review.seen ?? {})).toEqual(['a.txt']);
  });
});

describe('ReviewService pending reviews (FR-002, FR-003)', () => {
  it('lists the done or awaiting-prompt agents that changed at least one file', async () => {
    expect(await service.updatePending(workspace.id)).toEqual([]);
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    expect(await service.updatePending(workspace.id)).toEqual([AGENT_ID]);
    await setState('awaiting-prompt');
    expect(await service.updatePending(workspace.id)).toEqual([AGENT_ID]);
    await setState('working');
    expect(await service.updatePending(workspace.id)).toEqual([]);
    expect(pending.at(-1)).toEqual({ workspaceId: workspace.id, agentIds: [] });
  });

  it('announces only the latest pending list when an older computation ends last', async () => {
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    let calls = 0;
    // The first snapshot is slow: the agent starts working again before it ends.
    const slowGit = Object.create(gitService) as GitService;
    slowGit.snapshot = async (cwd) => {
      calls += 1;
      if (calls === 1) await new Promise((r) => setTimeout(r, 300));
      return gitService.snapshot(cwd);
    };
    service.dispose();
    service = createService({ git: slowGit });
    const older = service.updatePending(workspace.id);
    await setState('working');
    await service.updatePending(workspace.id);
    await older;
    expect(pending.at(-1)).toEqual({ workspaceId: workspace.id, agentIds: [] });
  });
});

describe('ReviewService conflicts with main (FR-018)', () => {
  it('says which files conflict, checked again when main moves', async () => {
    service.dispose();
    service = createService({ watch: () => () => undefined, safetyMs: 200 });
    await writeFile(join(worktree, 'a.txt'), 'un\nAGENT\n');
    expect(await service.open(AGENT_ID)).toMatchObject({ conflicts: 'none' });
    await writeFile(join(repo, 'a.txt'), 'un\nMAIN\n');
    git(repo, 'commit', '-am', 'main change');
    await waitFor(
      () => Array.isArray(changed.at(-1)?.conflicts),
      'no review:changed once main moved',
    );
    expect(changed.at(-1)).toMatchObject({
      conflicts: ['a.txt'],
      mainHead: git(repo, 'rev-parse', 'main'),
    });
  });
});

describe('ReviewService tests to run (FR-017, R8)', () => {
  it('runs them in the worktree with its port, on the tree shown', async () => {
    const snapshot = await service.open(AGENT_ID);
    expect(await service.testPlan(AGENT_ID)).toEqual({
      target: { agentId: AGENT_ID, cwd: worktree, port: 3001 },
      command: null,
      tree: snapshot.tree,
    });
  });

  it('detects the command, unless the workspace sets one', async () => {
    await writeFile(
      join(worktree, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    expect(await service.testPlan(AGENT_ID)).toMatchObject({ command: 'npm test' });
    await workspaces.update(workspace.id, (ws) => ({ ...ws, testCommand: 'make check' }));
    expect(await service.testPlan(AGENT_ID)).toMatchObject({ command: 'make check' });
    // The review says it too, so « non configurés » shows without asking (FR-016).
    expect(await service.open(AGENT_ID)).toMatchObject({ testCommand: 'make check' });
  });
});

describe('ReviewService when git fails', () => {
  it('reports the error instead of calling the work missing', async () => {
    service.dispose();
    service = createService({
      git: Object.assign(Object.create(gitService) as GitService, {
        snapshot: () => Promise.reject(new Error('fatal: Unable to create index.lock')),
      }),
    });
    await expect(service.open(AGENT_ID)).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('index.lock') as string,
    });
  });
});

const comments = () => workspaces.get(workspace.id)?.agents[0]?.review.comments ?? [];

describe('ReviewService comments (FR-012)', () => {
  it('keeps the comment and queues it for the agent with its file and line', async () => {
    const comment = await service.comment(
      AGENT_ID,
      'a.txt',
      2,
      'Le TTL devrait venir de la config.',
    );
    expect(comment).toMatchObject({
      path: 'a.txt',
      line: 2,
      text: 'Le TTL devrait venir de la config.',
      treated: false,
    });
    expect(comment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(comment.createdAt))).toBe(false);
    expect(comments()).toEqual([comment]);
    expect(typed).toEqual([
      { id: AGENT_ID, text: 'Commentaire sur a.txt:2 — Le TTL devrait venir de la config.' },
    ]);
  });

  it('keeps the comments after a restart', async () => {
    const comment = await service.comment(AGENT_ID, 'a.txt', 1, 'Plus court.');
    workspaces.dispose();
    stores = openStores(userData);
    workspaces = new WorkspaceService({ git: gitService, stores });
    await workspaces.open(repo);
    expect(comments()).toEqual([comment]);
  });

  it('refuses an unknown agent', async () => {
    await expect(
      service.comment('00000000-0000-4000-8000-000000000009', 'a.txt', 1, 'x'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(typed).toEqual([]);
  });
});

describe('ReviewService instructions (FR-013, FR-015)', () => {
  it('sends every untreated comment at once, then counts them treated (US3/AC2)', async () => {
    await service.comment(AGENT_ID, 'a.txt', 1, 'Un.');
    await service.comment(AGENT_ID, 'a.txt', 2, 'Deux.');
    typed = [];
    await service.send({ agentId: AGENT_ID, kind: 'fix-comments' });
    expect(typed).toEqual([
      {
        id: AGENT_ID,
        text: 'Corrige les commentaires de la revue :\n- a.txt:1 — Un.\n- a.txt:2 — Deux.',
      },
    ]);
    expect(comments().map((c) => c.treated)).toEqual([true, true]);
    // Nothing left to fix.
    await expect(service.send({ agentId: AGENT_ID, kind: 'fix-comments' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await service.comment(AGENT_ID, 'a.txt', 2, 'Trois.');
    typed = [];
    await service.send({ agentId: AGENT_ID, kind: 'fix-comments' });
    expect(typed[0]?.text).toBe('Corrige les commentaires de la revue :\n- a.txt:2 — Trois.');
  });

  it('sends the failing tests with their output, only when they fail (US3/AC3)', async () => {
    await expect(service.send({ agentId: AGENT_ID, kind: 'failing-tests' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    latestRun = {
      agentId: AGENT_ID,
      command: 'npm test',
      tree: '0'.repeat(40),
      status: 'passed',
      passedCount: 3,
      outputTail: '3 passed',
    };
    await expect(service.send({ agentId: AGENT_ID, kind: 'failing-tests' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    latestRun = { ...latestRun, status: 'failed', passedCount: null, outputTail: 'FAIL a.test.ts' };
    await service.send({ agentId: AGENT_ID, kind: 'failing-tests' });
    expect(typed).toEqual([
      {
        id: AGENT_ID,
        text: 'Les tests échouent (`npm test`). Corrige-les. Fin de la sortie :\nFAIL a.test.ts',
      },
    ]);
  });

  it('sends the conflicting files, only when there is a conflict (US3/AC3)', async () => {
    await writeFile(join(worktree, 'a.txt'), 'un\nAGENT\n');
    await service.open(AGENT_ID);
    await expect(service.send({ agentId: AGENT_ID, kind: 'conflict' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await writeFile(join(repo, 'a.txt'), 'un\nMAIN\n');
    git(repo, 'commit', '-am', 'main change');
    await service.send({ agentId: AGENT_ID, kind: 'conflict' });
    expect(typed).toEqual([
      {
        id: AGENT_ID,
        text:
          'Conflit avec main sur a.txt. Mets ta branche à jour depuis main, ' +
          'résous les conflits, puis relance les tests.',
      },
    ]);
  });

  it('sends a request as written, never an empty one', async () => {
    await service.send({ agentId: AGENT_ID, kind: 'request', text: 'Ajoute un test.' });
    expect(typed).toEqual([{ id: AGENT_ID, text: 'Ajoute un test.' }]);
    await expect(
      service.send({ agentId: AGENT_ID, kind: 'request', text: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
