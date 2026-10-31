import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, git, launchAgents, typeIn } from './helpers/workspace';

// 002 US4 end to end (T046): main and the agent change the same line. « Intégrer » opens screen
// 1q without touching main; resolved by hand, « Terminer » makes the commit; « Demander à
// l'agent » types the conflict prompt, and « Annuler » leaves main as it was.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('edit-echo'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us11-', {
    'src/données à jour.ts': 'un\ndeux\ntrois\n',
  }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

/** The agent changes line 2, then main changes it too; « ✓ Intégrer » meets the conflict. */
const integrateInConflict = async (page: Page) => {
  const [tile] = await launchAgents(launched as LaunchedApp, page, repo);
  if (!tile) throw new Error('no tile');
  await typeIn(page, tile, 'Change la ligne 2');
  await expect(tile).toHaveAttribute('data-state', 'done');
  await writeFile(join(repo, 'src', 'données à jour.ts'), 'un\ndeux de main\ntrois\n');
  git(repo, 'commit', '-qam', 'Ajout SSO');
  const main = git(repo, 'rev-parse', 'main');
  await tile.getByRole('button', { name: 'Revue →' }).click();
  const decision = page.getByRole('complementary', { name: 'Décision' });
  await expect(decision).toContainText('1 conflit avec main');
  await decision.getByRole('button', { name: '✓ Intégrer' }).click();

  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await expect(focus.getByRole('tab', { name: 'Conflits · 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Nothing moved: main, its folder (FR-027, SC-003).
  expect(git(repo, 'rev-parse', 'main')).toBe(main);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  return { focus, column: page.getByRole('complementary', { name: 'Intégration' }), main };
};

test('resolves a conflict by hand, then finishes the integration', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { focus, column, main } = await integrateInConflict(page);

  const hunk = focus.getByRole('group', {
    name: 'src/données à jour.ts · conflit 1 / 1 · ligne 2',
  });
  await expect(hunk).toContainText('main · « Ajout SSO »');
  await expect(hunk).toContainText('deux de main');
  await expect(hunk).toContainText('deux de l’agent');
  const finish = column.getByRole('button', { name: 'Terminer l’intégration' });
  await expect(finish).toBeDisabled();
  await hunk.getByRole('button', { name: 'Garder cette version' }).click();
  await expect(column).toContainText('1 / 1 résolu');
  await finish.click();

  await expect(page.getByRole('status').filter({ hasText: '✓ Intégré' })).toHaveText(
    '✓ Intégré · agent/fake-1 → main',
  );
  expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([main]);
  expect(git(repo, 'show', 'main:src/données à jour.ts')).toBe('un\ndeux de l’agent\ntrois');
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('asks the agent, then cancels with main unchanged', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { focus, column, main } = await integrateInConflict(page);

  await column.getByRole('region', { name: 'Recommandé' }).getByRole('button').click();
  await expect(focus.getByLabel('Terminal de Faux CLI 1')).toContainText(
    'Reçu : Ta branche est en conflit avec main sur : src/données à jour.ts.',
  );
  // The fake CLI does not merge main: once its turn ends, the conflict is still there.
  await expect(column).toContainText('1 conflit avec main');
  await expect(
    column.getByRole('region', { name: 'Recommandé' }).getByRole('button'),
  ).toBeEnabled();

  await column.getByRole('button', { name: 'Annuler l’intégration' }).click();
  await expect(page.getByRole('complementary', { name: 'Intégration' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Décision' })).toBeVisible();
  expect(git(repo, 'rev-parse', 'main')).toBe(main);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});
