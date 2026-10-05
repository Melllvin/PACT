import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { IntegrationService } from '../../../src/main/review/integration-service';
import { IpcFailure } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import type { Integration } from '../../../src/shared/review';

// 002 T027 — integrating an agent's changes into main (research R5, FR-019 to FR-026).

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
/** Not trimmed: the first column tells staged from unstaged. */
const status = (cwd: string) =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';

let root: string;
let repo: string;
let worktree: string;
let integrations: string;
let workspace: Workspace;
let gitService: GitService;
let states: Integration[];
let closed: { id: string; removeWorktree: boolean }[];

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};

const hook = async (name: string, script: string) => {
  const path = join(repo, '.git', 'hooks', name);
  await write(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
};

const agent = (id: string, worktreePath: string, state: AgentState = 'done'): Agent => ({
  id,
  workspaceId: workspace.id,
  position: id === AGENT_ID ? 1 : 2,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: id === AGENT_ID ? 'agent/claude-code-1' : 'agent/claude-code-2',
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

const createService = (git: Partial<GitService> = {}) =>
  new IntegrationService({
    git: Object.assign(Object.create(gitService) as GitService, git),
    workspaces: { list: () => [workspace] },
    agents: {
      close: (id, { removeWorktree }) => {
        closed.push({ id, removeWorktree });
        return Promise.resolve();
      },
    },
    integrationsDir: integrations,
    onState: (integration) => states.push(integration),
  });

const start = (
  service: IntegrationService,
  overrides: Partial<Parameters<IntegrationService['start']>[0]> = {},
) =>
  service.start({
    agentId: AGENT_ID,
    mode: 'squash',
    message: 'Ajoute le total',
    after: { closeTile: true, removeWorktree: true },
    ...overrides,
  });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as IpcFailure,
  );

const parents = (commit: string) =>
  git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-integration-')));
  repo = join(root, 'Mes Projets', 'Développement');
  integrations = join(root, 'userData', 'integrations');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
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
  workspace = { ...workspace, agents: [agent(AGENT_ID, worktree)] };
  gitService = new GitService({ env: gitEnv });
  states = [];
  closed = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('IntegrationService, squash (FR-019)', () => {
  it('makes one commit on main with the snapshot and the message, then closes the agent', async () => {
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await write(join(worktree, 'Dossier é', 'nouveau fichier.txt'), 'nouveau\n');
    commitAll(worktree, 'Étape 1');
    await write(join(worktree, 'b.txt'), 'b non commité\n');
    const service = createService();
    const integration = await start(service, { message: 'Ajoute le total\n\nDétails' });
    expect(integration).toMatchObject({
      agentId: AGENT_ID,
      mode: 'squash',
      state: 'integrated',
      mainAtStart: before,
      conflicts: [],
      error: null,
    });
    const main = git(repo, 'rev-parse', 'main');
    expect(parents(main)).toEqual([before]);
    expect(git(repo, 'log', '-1', '--format=%B', 'main')).toBe('Ajoute le total\n\nDétails');
    expect(git(repo, 'show', 'main:Dossier é/nouveau fichier.txt')).toBe('nouveau');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b non commité');
    // main is checked out in the repository: its folder follows.
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('un\nDEUX\ntrois\n');
    expect(status(repo)).toBe('');
    expect(states.map((s) => s.state)).toEqual(['checking', 'committing', 'integrated']);
    expect(closed).toEqual([{ id: AGENT_ID, removeWorktree: true }]);
    expect(await readdir(integrations).catch(() => [])).toEqual([]);
  });

  it('carries the changes of main made meanwhile, in the result', async () => {
    await write(join(repo, 'b.txt'), 'b de main\n');
    commitAll(repo, 'Main change b');
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await start(createService());
    expect(parents(git(repo, 'rev-parse', 'main'))).toEqual([before]);
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b de main');
  });

  it('asks first when the agent is still working (FR-025)', async () => {
    workspace = { ...workspace, agents: [agent(AGENT_ID, worktree, 'working')] };
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const service = createService();
    expect((await failure(start(service))).code).toBe('INVALID_INPUT');
    expect(states).toEqual([]);
    expect(await start(service, { confirmWorking: true })).toMatchObject({ state: 'integrated' });
  });

  it('stops on a conflict with main, which stays unchanged (FR-027)', async () => {
    await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
    commitAll(repo, 'Ajout SSO');
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
    await write(join(worktree, 'b.txt'), 'b de l’agent\n');
    const integration = await start(createService());
    expect(integration).toMatchObject({
      state: 'conflicted',
      conflicts: [
        {
          path: 'a.txt',
          kind: 'content',
          mainCommit: { short: git(repo, 'rev-parse', '--short', 'main'), subject: 'Ajout SSO' },
          edited: null,
          resolved: false,
        },
      ],
    });
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(status(repo)).toBe('');
    expect(closed).toEqual([]);
  });
});

describe('IntegrationService, keep commits (FR-019)', () => {
  it('fast-forwards main to the commits of the agent, messages kept', async () => {
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    commitAll(worktree, 'Étape 1');
    await write(join(worktree, 'b.txt'), 'b 2\n');
    commitAll(worktree, 'Étape 2');
    const head = git(worktree, 'rev-parse', 'HEAD');
    await start(createService(), { mode: 'keep-commits', message: 'Inutilisé' });
    expect(git(repo, 'rev-parse', 'main')).toBe(head);
    expect(git(repo, 'log', '--format=%s', `${before}..main`)).toBe('Étape 2\nÉtape 1');
  });

  it('makes the uncommitted changes a last commit, with the message', async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    commitAll(worktree, 'Étape 1');
    const head = git(worktree, 'rev-parse', 'HEAD');
    await write(join(worktree, 'b.txt'), 'b non commité\n');
    await start(createService(), { mode: 'keep-commits', message: 'Fin du travail' });
    expect(parents(git(repo, 'rev-parse', 'main'))).toEqual([head]);
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Fin du travail');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b non commité');
  });

  it('makes a merge commit when main moved meanwhile', async () => {
    await write(join(repo, 'b.txt'), 'b de main\n');
    commitAll(repo, 'Main change b');
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    commitAll(worktree, 'Étape 1');
    const head = git(worktree, 'rev-parse', 'HEAD');
    await start(createService(), { mode: 'keep-commits', message: 'Intègre claude-code-1' });
    const main = git(repo, 'rev-parse', 'main');
    expect(parents(main)).toEqual([before, head]);
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Intègre claude-code-1');
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b de main');
  });
});

describe('IntegrationService, hooks (FR-023)', () => {
  it('fails with the output of a refusing pre-commit hook, main unchanged', async () => {
    await hook('pre-commit', 'echo "lint: 2 erreurs"\nexit 1');
    const before = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const error = await failure(start(createService()));
    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toContain('lint: 2 erreurs');
    expect(states.at(-1)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('lint: 2 erreurs') as unknown,
    });
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(await readdir(integrations).catch(() => [])).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('keeps the message a commit-msg hook rewrote', async () => {
    await hook(
      'commit-msg',
      'printf "[PROJ-1] %s\\n" "$(cat "$1")" > "$1.new" && mv "$1.new" "$1"',
    );
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await start(createService());
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('[PROJ-1] Ajoute le total');
  });
});

describe('IntegrationService, moving main (FR-021, FR-022)', () => {
  it('refuses over local changes to a file it touches, listing them, nothing changed', async () => {
    const before = git(repo, 'rev-parse', 'main');
    await write(join(repo, 'a.txt'), 'modifié à la main\n');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const error = await failure(start(createService()));
    expect(error).toMatchObject({ code: 'LOCAL_CHANGES', files: ['a.txt'] });
    expect(states.at(-1)?.state).toBe('blocked');
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('modifié à la main\n');
    expect(closed).toEqual([]);
  });

  it('keeps local changes to other files', async () => {
    await write(join(repo, 'b.txt'), 'b local\n');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await start(createService());
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b local\n');
  });

  it('moves main with an atomic update-ref when it is not checked out', async () => {
    git(repo, 'switch', '-q', '-c', 'travail');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await start(createService());
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('travail');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('un\ndeux\ntrois\n');
  });

  it('checks again once when main moves during the integration', async () => {
    git(repo, 'switch', '-q', '-c', 'travail');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    let moves = 0;
    const service = createService({
      updateRef: async (cwd, branch, next, expected) => {
        if (moves++ === 0) {
          await write(join(repo, 'b.txt'), 'b ailleurs\n');
          git(repo, 'commit', '-q', '-am', 'Ailleurs');
          git(repo, 'branch', '-f', 'main', 'travail');
        }
        return gitService.updateRef(cwd, branch, next, expected);
      },
    });
    const integration = await start(service);
    expect(integration.state).toBe('integrated');
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b ailleurs');
    expect(states.filter((s) => s.state === 'checking')).toHaveLength(2);
  });

  it('gives up with MAIN_MOVED when main moves again', async () => {
    git(repo, 'switch', '-q', '-c', 'travail');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    let moves = 0;
    const service = createService({
      updateRef: async (cwd, branch, next, expected) => {
        await write(join(repo, 'b.txt'), `b ${String(++moves)}\n`);
        git(repo, 'commit', '-q', '-am', `Ailleurs ${String(moves)}`);
        git(repo, 'branch', '-f', 'main', 'travail');
        return gitService.updateRef(cwd, branch, next, expected);
      },
    });
    const error = await failure(start(service));
    expect(error.code).toBe('MAIN_MOVED');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'travail'));
    expect(closed).toEqual([]);
  });

  it('runs the integrations of a workspace one after the other (FR-026)', async () => {
    const second = join(repo, '.worktrees', 'claude-code-2');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/claude-code-2', second, 'main');
    workspace = { ...workspace, agents: [agent(AGENT_ID, worktree), agent(SECOND_ID, second)] };
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await write(join(second, 'b.txt'), 'b du second\n');
    let inFlight = 0;
    let most = 0;
    const service = createService({
      commitWithHooks: async (...args) => {
        most = Math.max(most, ++inFlight);
        try {
          return await gitService.commitWithHooks(...args);
        } finally {
          inFlight--;
        }
      },
    });
    const [first, other] = await Promise.all([
      start(service),
      start(service, { agentId: SECOND_ID, message: 'Second' }),
    ]);
    expect(most).toBe(1);
    expect([first.state, other.state]).toEqual(['integrated', 'integrated']);
    expect(git(repo, 'log', '--format=%s', 'main')).toBe('Second\nAjoute le total\ninitial');
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'show', 'main:b.txt')).toBe('b du second');
  });

  it('goes on with the next integration after one fails', async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    let calls = 0;
    const service = createService({
      commitWithHooks: (...args) =>
        calls++ === 0
          ? Promise.reject(new Error('disque plein'))
          : gitService.commitWithHooks(...args),
    });
    expect((await failure(start(service))).message).toContain('disque plein');
    expect((await start(service)).state).toBe('integrated');
  });
});

describe('IntegrationService, the agent afterwards (FR-024, US2/AC4)', () => {
  const keep = { closeTile: false, removeWorktree: false };

  it('closes the tile but keeps the worktree, moved onto main', async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    await start(createService(), { after: { closeTile: true, removeWorktree: false } });
    expect(closed).toEqual([{ id: AGENT_ID, removeWorktree: false }]);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    expect(status(worktree)).toBe('');
  });

  it('keeps the agent, its worktree reset onto main when nothing changed since', async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    commitAll(worktree, 'Étape 1');
    await write(join(worktree, 'nouveau.txt'), 'nouveau\n');
    await start(createService(), { after: keep });
    expect(closed).toEqual([]);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    expect(status(worktree)).toBe('');
  });

  it('carries over what the agent wrote after the snapshot', async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    let wrote = false;
    const service = createService({
      fastForward: async (cwd, commit) => {
        await gitService.fastForward(cwd, commit);
        if (!wrote) {
          wrote = true;
          await write(join(worktree, 'b.txt'), 'b écrit après\n');
        }
      },
    });
    await start(service, { after: keep });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    expect(status(worktree)).toBe(' M b.txt\n');
    expect(await readFile(join(worktree, 'b.txt'), 'utf8')).toBe('b écrit après\n');
  });

  it('leaves the worktree as it is when those later writes conflict', async () => {
    await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
    commitAll(repo, 'Main change a');
    await write(join(worktree, 'b.txt'), 'b de l’agent\n');
    const head = git(worktree, 'rev-parse', 'HEAD');
    const service = createService({
      fastForward: async (cwd, commit) => {
        await gitService.fastForward(cwd, commit);
        await write(join(worktree, 'a.txt'), 'un\nDeux réécrit par l’agent\ntrois\n');
      },
    });
    expect((await start(service, { after: keep })).state).toBe('integrated');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(worktree, 'a.txt'), 'utf8')).toBe(
      'un\nDeux réécrit par l’agent\ntrois\n',
    );
  });
});
