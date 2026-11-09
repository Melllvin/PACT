import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { answerFolderPickers, type LaunchedApp } from './launch-app';

// The steps the review specs of 002 share: a repository, agents launched, a prompt typed.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** A repository on `main` with `files` committed, under a path with spaces and accents. */
export async function createRepo(prefix: string, files: Record<string, string>) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
  const repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  // PACT commits as the user: the identity comes from the repository, not from the test's env.
  git(repo, 'config', 'user.name', 'PACT Test');
  git(repo, 'config', 'user.email', 'test@pact.dev');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return { root, repo };
}

/** Sets a counter of the quick launcher (1c) to `target`. */
const setCount = async (group: Locator, target: number) => {
  const count = group.getByRole('status');
  for (;;) {
    const value = Number(await count.textContent());
    if (value === target) return;
    await group
      .getByRole('button', { name: value < target ? /^Ajouter un / : /^Retirer un / })
      .click();
  }
};

/** Opens `repo` and launches `count` fake agents, always allowed (1c, then 1m). */
export async function launchAgents({ app }: LaunchedApp, page: Page, repo: string, count = 1) {
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), count);
  await launcher
    .getByRole('button', { name: `Lancer ${String(count)} agent${count > 1 ? 's' : ''}` })
    .click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tiles = Array.from({ length: count }, (_, i) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(i + 1)},`) }),
  );
  for (const tile of tiles) await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  return tiles;
}

export async function typeIn(page: Page, tile: Locator, text: string) {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The worktree of agent `n`, from git itself (which writes `C:/…` on Windows). */
export const agentWorktree = (repo: string, n = 1) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((path) => path.endsWith(`/.worktrees/fake-${String(n)}`)) ?? '';

/**
 * Everything the agent at `position` (« Faux CLI 3 » is 3) has printed so far, from PACT's own log of its terminal. A tile
 * shows only the rows in view, and on a small screen (a CI runner) a few turns push the earlier ones
 * out: what a test counts or reads across several turns is read here, not in the tile.
 */
export async function outputOf(page: Page, position: number): Promise<string> {
  return page.evaluate(async (at) => {
    type Pact = { invoke(channel: string, input?: unknown): Promise<unknown> };
    const pact = (window as unknown as { pact: Pact }).pact;
    const state = (await pact.invoke('app:getState')) as {
      workspaces: { agents: { id: string; position: number }[] }[];
    };
    const agent = state.workspaces.flatMap((w) => w.agents).find((a) => a.position === at);
    return agent ? ((await pact.invoke('agent:log', { agentId: agent.id })) as string) : '';
  }, position);
}

/**
 * The reports PACT has stored from the agent at `position`, across the rounds of the loops. It counts
 * what PACT received, not the words of the terminal: ConPTY redraws a full screen and may cut a
 * line it wraps with cursor moves, so a sentence of the agent is not always whole in its log.
 */
export async function reportsStoredFrom(page: Page, position: number): Promise<number> {
  return page.evaluate(async (at) => {
    type Pact = { invoke(channel: string, input?: unknown): Promise<unknown> };
    const pact = (window as unknown as { pact: Pact }).pact;
    const state = (await pact.invoke('app:getState')) as {
      workspaces: {
        agents: { id: string; position: number }[];
        loops?: { rounds: { reports: { agentId: string }[] }[] }[];
      }[];
    };
    return state.workspaces.reduce((total, workspace) => {
      const agent = workspace.agents.find((a) => a.position === at);
      if (!agent) return total;
      const rounds = (workspace.loops ?? []).flatMap((loop) => loop.rounds);
      return total + rounds.flatMap((r) => r.reports).filter((r) => r.agentId === agent.id).length;
    }, 0);
  }, position);
}
