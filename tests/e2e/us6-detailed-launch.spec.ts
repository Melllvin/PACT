import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US6 end to end with the fake CLI: detailed launch, conflicts, « Autre CLI — ajouter » (T097).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

const branchAndPort = async (tile: Locator) => {
  const button = tile.getByRole('button', { name: 'Branche et port' });
  await button.hover();
  // Radix renders the tooltip in a portal, out of the tile, and describes the button with it;
  // the tooltip of the previous tile may still be fading out.
  await expect(button).toHaveAttribute('aria-describedby', /.+/);
  const id = await button.getAttribute('aria-describedby');
  const text = await tile
    .page()
    .locator(`[id="${String(id)}"]`)
    .textContent();
  await tile.page().mouse.move(0, 0);
  return text;
};

/** 1d with two fake agents, from a freshly opened workspace. */
const openDetailed = async (page: Page) => {
  if (!launched) throw new Error('the app is not running');
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await quick.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' }).click();
  await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
  const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
  const agents = detailed.getByRole('list', { name: 'Agents' }).getByRole('listitem');
  await expect(agents).toHaveCount(2);
  return { detailed, agents };
};

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us6-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('launches 2 agents with their own branches, a custom port, in the order chosen', async () => {
  test.setTimeout(90_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { detailed, agents } = await openDetailed(page);
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });

  await agents
    .nth(0)
    .getByRole('button', { name: /^Faux CLI/ })
    .click();
  await inspector.getByRole('textbox', { name: 'Branche', exact: true }).fill('feature/login');
  await inspector.getByRole('textbox', { name: 'Port' }).fill('4100');
  await agents
    .nth(1)
    .getByRole('button', { name: /^Faux CLI/ })
    .click();
  await inspector.getByRole('textbox', { name: 'Branche', exact: true }).fill('feature/api');

  // Dragged first: feature/api gets the first tile, its color and its automatic port.
  await agents.nth(1).getByRole('button', { name: 'Déplacer Faux CLI' }).dragTo(agents.nth(0));
  await expect(agents.nth(0)).toContainText('feature/api');

  await detailed.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await expect(page.getByRole('dialog', { name: 'Autorisations des agents' })).toBeVisible();
  await page.keyboard.press('Enter');

  const first = page.getByRole('article', { name: /^Faux CLI 1,/ });
  const second = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(branchAndPort(first)).resolves.toBe('feature/api · :3001');
  await expect(branchAndPort(second)).resolves.toBe('feature/login · :4100');
  const worktrees = git(repo, 'worktree', 'list');
  expect(worktrees).toContain('[feature/api]');
  expect(worktrees).toContain('[feature/login]');
});

test('blocks the launch while two agents share a port', async () => {
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { detailed, agents } = await openDetailed(page);
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
  for (const index of [0, 1]) {
    await agents
      .nth(index)
      .getByRole('button', { name: /^Faux CLI/ })
      .click();
    await inspector.getByRole('textbox', { name: 'Port' }).fill('4100');
  }
  await expect(detailed.getByRole('alert')).toContainText('4100');
  await expect(detailed.getByRole('button', { name: 'Lancer 2 agents' })).toBeDisabled();
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
});

test('adds a CLI from the home screen, warning when its command is not found', async () => {
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const detected = page.getByRole('region', { name: 'Agents détectés' });

  const add = async (name: string, command: string) => {
    await detected.getByRole('button', { name: 'Autre CLI — ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ajouter un CLI' });
    await dialog.getByRole('textbox', { name: 'Nom' }).fill(name);
    await dialog.getByRole('textbox', { name: 'Commande' }).fill(command);
    await dialog.getByRole('button', { name: 'Ajouter' }).click();
    await expect(dialog).toBeHidden();
  };
  await add('Goose', 'goose-introuvable-pact');
  await expect(detected.getByRole('listitem', { name: 'Goose' })).toContainText(
    'commande « goose-introuvable-pact » introuvable',
  );
  await add('Node', 'node --version');
  await expect(detected.getByRole('listitem', { name: 'Node' })).toContainText('✓ Node');

  // Offered at launch through « Autre CLI… ».
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const other = page
    .getByRole('dialog', { name: 'Ajouter au workspace' })
    .getByRole('group', { name: 'Autre CLI…' });
  await expect(other.getByRole('button', { name: '+' })).toBeEnabled();
});
