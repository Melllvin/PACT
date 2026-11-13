import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { WorkflowSource } from '../../../src/main/workflow/workflow-source';
import { defaultDeliverySettings } from '../../../src/shared/delivery';
import type { Workspace } from '../../../src/shared/model';
import { WORKFLOW_PATH, defaultWorkflow } from '../../../src/shared/workflow';

// 010 T016 — the workflow in force is read in the repository (research R10), never written when there is
// no file (FR-011, US1 sc.1, sc.4), and the settings of 008 are the default (FR-020).

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let delivery = defaultDeliverySettings();

const workspace = (): Workspace =>
  ({ id: 'w1', path: repo, mainBranch: 'main', delivery }) as Workspace;
const source = () =>
  new WorkflowSource({
    git: new GitService({ env: gitEnv }),
    workspaces: { get: (id: string) => (id === 'w1' ? workspace() : undefined) },
  });

const FILE = `version: 1
name: perso
agents:
  tester: { role: test }
  dev: { role: dev }
stages:
  - { id: test, type: test, agents: [tester] }
  - { id: dev, type: dev, agents: [dev] }
  - { id: pr, type: pr, mergeMode: rebase }
transitions:
  - { from: test, to: dev, on: [tests-written, defects], maxRounds: 4 }
  - { from: dev, to: test, on: [done] }
  - { from: test, to: pr, on: [accepted] }
start: test
ends: [pr]
`;

beforeEach(async () => {
  delivery = defaultDeliverySettings();
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-workflow-')));
  repo = join(root, 'Mes Projets');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a project without a workflow file (US1 sc.1, sc.4, FR-011)', () => {
  it('Given no file on main, When the workflow is read, Then it is the default of the settings of 008, from no file', async () => {
    const current = await source().current('w1');

    expect(current).toMatchObject({
      source: 'default',
      oid: 'default',
      workflow: defaultWorkflow(defaultDeliverySettings()),
      ignoredLocal: [],
    });
  });

  it('Given no file, When the workflow is read, Then nothing is written: the tree and git status are as they were', async () => {
    const before = git(repo, 'status', '--porcelain=v1', '--ignored');
    const listing = await readdir(repo);

    await source().current('w1');
    await source().current('w1');

    expect(git(repo, 'status', '--porcelain=v1', '--ignored')).toBe(before);
    expect(await readdir(repo)).toEqual(listing);
    await expect(readFile(join(repo, WORKFLOW_PATH), 'utf8')).rejects.toThrow();
  });

  it('Given settings of 008 that are not the defaults, When the workflow is read, Then they are the values of the default workflow (FR-020)', async () => {
    delivery = {
      ...delivery,
      mergeMode: 'merge',
      maxRounds: 5,
      polishPasses: 2,
      polishBrief: 'Noms',
    };

    const { workflow, source: from } = await source().current('w1');

    expect(from).toBe('default');
    expect(workflow).toEqual(defaultWorkflow(delivery));
    expect(workflow.transitions.find((t) => t.to === 'dev')?.maxRounds).toBe(5);
    expect(workflow.stages.find((s) => s.type === 'polish')).toMatchObject({
      passes: 2,
      instruction: 'Noms',
    });
    expect(workflow.stages.find((s) => s.type === 'pr')?.mergeMode).toBe('merge');
  });
});

describe('a valid file on the main branch (research R10)', () => {
  it('Given a file committed on main, When the workflow is read, Then it is the file, its blob as oid', async () => {
    await mkdir(join(repo, '.pact'), { recursive: true });
    await writeFile(join(repo, WORKFLOW_PATH), FILE);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'workflow');
    const oid = git(repo, 'rev-parse', `main:${WORKFLOW_PATH}`);

    const current = await source().current('w1');

    expect(current).toMatchObject({ source: 'file', oid });
    expect(current.workflow.name).toBe('perso');
    expect(current.workflow.stages.map((s) => s.id)).toEqual(['test', 'dev', 'pr']);
  });

  it('Given the file only in the worktree of an agent’s branch, When it is read, Then it is ignored (FR-007)', async () => {
    const worktree = join(repo, '.worktrees', 'claude-code-1');
    git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
    await mkdir(join(worktree, '.pact'), { recursive: true });
    await writeFile(join(worktree, WORKFLOW_PATH), FILE);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'workflow, for itself');

    const current = await source().current('w1');

    expect(current.source).toBe('default');
  });

  it('Given a remote whose main has the file and a local main that has not, When it is read, Then origin/main wins', async () => {
    const bare = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', bare);
    git(repo, 'remote', 'add', 'origin', bare);
    await mkdir(join(repo, '.pact'), { recursive: true });
    await writeFile(join(repo, WORKFLOW_PATH), FILE);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'workflow');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'fetch', 'origin');
    git(repo, 'reset', '--hard', 'HEAD~1');

    const current = await source().current('w1');

    expect(current.source).toBe('file');
    expect(current.workflow.name).toBe('perso');
  });
});

describe('a file that cannot be used (the editor of a later phase handles it)', () => {
  it('Given a broken file on main, When it is read, Then the default stands in and the errors are listed', async () => {
    await mkdir(join(repo, '.pact'), { recursive: true });
    await writeFile(join(repo, WORKFLOW_PATH), 'version: 1\nname: [\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'broken workflow');

    const current = await source().current('w1');

    expect(current.source).toBe('default');
    expect(current.workflow).toEqual(defaultWorkflow(defaultDeliverySettings()));
    expect(current.errors.length).toBeGreaterThan(0);
  });

  it('Given a file that overrides the settings of 008, When it is read, Then the settings it overrides are named', async () => {
    await mkdir(join(repo, '.pact'), { recursive: true });
    await writeFile(join(repo, WORKFLOW_PATH), FILE);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'workflow');

    const current = await source().current('w1');

    expect(current.ignoredLocal).toEqual(expect.arrayContaining(['maxRounds', 'mergeMode']));
  });

  it('Given a project that is not a repository, When it is read, Then the default stands in', async () => {
    const elsewhere = join(root, 'not-a-repo');
    await mkdir(elsewhere);
    const lone = new WorkflowSource({
      git: new GitService({ env: gitEnv }),
      workspaces: {
        get: () => ({ path: elsewhere, mainBranch: 'main', delivery: defaultDeliverySettings() }),
      },
    });

    expect((await lone.current('w1')).source).toBe('default');
  });

  it('Given a workspace that is gone, When it is read, Then it is an error', async () => {
    await expect(source().current('nope')).rejects.toThrow('Workspace inconnu');
  });
});
