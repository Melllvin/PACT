import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US1 end to end: open, go to an existing tab, « + », clone, restart (tasks T042).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

let root: string;
let repo: string;
let bare: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us1-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  bare = join(root, 'origin.git');
  git(root, 'clone', '--bare', repo, bare);
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('opens a repository, goes back to its tab, clones another and restores both', async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const page = await launched.app.firstWindow();

  // Scenario 1: choose a repository → a new active tab on its empty workspace (1b).
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('tab', { name: 'Développement' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: /Ajouter des agents/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /À faire/ })).toHaveCount(0);

  // Scenarios 3 and 4: « + » opens the home tab; reopening switches to the existing tab.
  await page.getByRole('button', { name: 'Nouvel onglet' }).click();
  await expect(page.getByRole('heading', { name: 'Ouvrir un workspace' })).toBeVisible();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('tab', { name: 'Développement' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab')).toHaveCount(1);

  // Scenario 2: clone a bare repository into a chosen folder → it opens as a workspace.
  await page.getByRole('button', { name: 'Nouvel onglet' }).click();
  await page.getByRole('button', { name: 'Cloner depuis une URL…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cloner un dépôt' });
  await dialog.getByRole('textbox', { name: 'URL du dépôt' }).fill(pathToFileURL(bare).href);
  await answerFolderPickers(launched.app, join(root, 'clone é'));
  await dialog.getByRole('button', { name: 'Choisir…' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Destination' })).toHaveValue(
    join(root, 'clone é'),
  );
  await dialog.getByRole('button', { name: 'Cloner' }).click();
  await expect(page.getByRole('tab', { name: 'clone é' })).toHaveAttribute(
    'aria-selected',
    'true',
    {
      timeout: 30_000,
    },
  );

  // FR-005: after a restart both workspaces are back and appear in the recents.
  const { userDataDir } = launched;
  await launched.close({ keepData: true });
  launched = await launchApp({ userDataDir });
  const restarted = await launched.app.firstWindow();
  await expect(restarted.getByRole('tab', { name: 'Développement' })).toBeVisible();
  await expect(restarted.getByRole('tab', { name: 'clone é' })).toBeVisible();
  await restarted.getByRole('button', { name: 'Fermer clone é' }).click();
  await restarted.getByRole('button', { name: 'Nouvel onglet' }).click();
  const recents = restarted.getByRole('region', { name: 'Récents' });
  await expect(recents.getByRole('heading', { name: 'clone é' })).toBeVisible();
});

test('explains a folder that is not a repository and initializes it on request', async () => {
  launched = await launchApp();
  const page = await launched.app.firstWindow();
  const plain = join(root, 'notes');
  await mkdir(plain);

  await answerFolderPickers(launched.app, plain);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('n’est pas un dépôt Git');
  await alert.getByRole('button', { name: 'Initialiser un dépôt ici' }).click();
  await expect(page.getByRole('tab', { name: 'notes' })).toHaveAttribute('aria-selected', 'true');
});
