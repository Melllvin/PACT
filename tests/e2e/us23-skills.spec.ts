import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, git } from './helpers/workspace';

// 004 US6 end to end (T044): a CLI added by hand, launched as « test », gets its skills in
// .pact/ROLE.md, out of Git, and the instruction to read it (R3, FR-013).

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us23-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('gives a generic agent its role in .pact/ROLE.md and tells it to read it', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done'),
    },
  });
  const page = await launched.app.firstWindow();

  // « Autre CLI »: the fake CLI run as an unknown one.
  const detected = page.getByRole('region', { name: 'Agents détectés' });
  await detected.getByRole('button', { name: 'Autre CLI — ajouter' }).click();
  const add = page.getByRole('dialog', { name: 'Ajouter un CLI' });
  await add.getByRole('textbox', { name: 'Nom' }).fill('Autre');
  await add.getByRole('textbox', { name: 'Commande' }).fill(`${process.execPath} ${FAKE_CLI}`);
  await add.getByRole('button', { name: 'Ajouter' }).click();
  await expect(detected.getByRole('listitem', { name: 'Autre' })).toContainText('✓ Autre');

  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await quick
    .getByRole('group', { name: 'Autre CLI…' })
    .getByRole('button', { name: /^Ajouter un / })
    .click();
  await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
  const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
  await detailed
    .getByRole('list', { name: 'Agents' })
    .getByRole('button', { name: /^Autre branche/ })
    .click();
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
  await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('test');
  // The profile of « test » brings its own CLI: the agent keeps the one added by hand.
  await inspector.getByRole('combobox', { name: 'CLI' }).selectOption({ label: 'Autre' });
  await expect(inspector.getByRole('combobox', { name: 'Rôle' })).toHaveValue('test');
  await detailed.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »

  const tile = page.getByRole('article', { name: /^Autre \d,/ });
  await expect(tile).toContainText('Lis .pact/ROLE.md');
  const worktree =
    git(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .find((path) => /\/\.worktrees\/[^/]*autre[^/]*-\d$/.test(path)) ?? '';
  const role = await readFile(join(worktree, '.pact', 'ROLE.md'), 'utf8');
  expect(role).toContain('name: pact-test');
  expect(role).toContain('# Contrat PACT');
  expect(git(worktree, 'status', '--porcelain')).toBe('');
});
