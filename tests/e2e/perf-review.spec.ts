import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, launchAgents, typeIn } from './helpers/workspace';

// 002 T056 — SC-001 (50 files: the list and the first diff in under 2 s) and SC-006 (a write in
// the worktree shown in under 3 s). SC-004 (a comment in the prompt in under 1 s) is measured by
// us10-review-comments.spec.ts.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('edit-50-files'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-perf-review-', { 'README.md': '# perf\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('opens the review of 50 files in under 2 s, and shows a new write in under 3 s', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const [tile] = await launchAgents(launched, page, repo);
  if (!tile) throw new Error('no tile');
  await typeIn(page, tile, 'Écris 50 fichiers');
  await expect(tile).toHaveAttribute('data-state', 'done');
  const review = tile.getByRole('button', { name: 'Revue →' });
  await expect(review).toBeVisible();

  const opening = Date.now();
  await review.click();
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await expect(focus.getByRole('list', { name: 'Fichiers' }).getByRole('listitem')).toHaveCount(
    50,
    { timeout: 2000 },
  );
  await expect(
    focus.getByRole('table', { name: 'Diff de src/module-01.ts' }).getByRole('row').nth(1),
  ).toBeVisible({ timeout: 2000 });
  const opened = Date.now() - opening;

  const writing = Date.now();
  await writeFile(join(agentWorktree(repo), 'src', 'module-01.ts'), 'export const fin = 1;\n');
  await expect(
    focus
      .getByRole('table', { name: 'Diff de src/module-01.ts' })
      .getByText('export const fin = 1;'),
  ).toBeVisible({ timeout: 3000 });
  const shown = Date.now() - writing;

  test
    .info()
    .annotations.push(
      { type: 'review of 50 files (ms)', description: String(opened) },
      { type: 'write shown (ms)', description: String(shown) },
    );
  expect(opened).toBeLessThan(2000);
  expect(shown).toBeLessThan(3000);
});
