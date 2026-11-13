import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { git } from './helpers/workspace';
import { createHarness, ISSUE, type Harness } from './helpers/workflow-harness';

// 010 US1 end to end (T018): a project WITHOUT `.pact/workflow.yaml` runs the chain of 004 and 008 as a
// default workflow. One run per issue, its stage written before the journal says it, nothing written in the
// repository (FR-011). Nothing real: fake CLI, fake `gh`, bare remote on the disk.
//
// RED until the engine of the workflows is wired (T020 to T025). Assumed: `workspace.runs[]` is saved with
// `stage`, `status`, `oid: 'default'`; the journal holds messages of kind `stage`.

let h: Harness;

test.beforeEach(async () => {
  h = await createHarness('pact-us60-');
});
test.afterEach(async () => {
  await h.close();
});

test('US1 sc.1-3: no file: a run in the default workflow follows the loop, a stage message per step, and the repository stays without file', async () => {
  test.setTimeout(300_000);
  const page = await h.openWithIssue();
  const { lead, dev, tester } = await h.launchTeam(page);
  await h.work();

  await h.call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });

  // One run, on the default version, in a stage of the chain (sc.1).
  await expect.poll(async () => (await h.saved()).runs.length, { timeout: 30_000 }).toBe(1);
  const first = (await h.saved()).runs[0];
  expect(first).toMatchObject({ issueId: ISSUE, oid: 'default', status: 'active' });
  expect(['test', 'dev']).toContain(first?.stage);

  // The proof of PACT on the accepted verdict: the run leaves the loop (sc.2).
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await h.call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText(
    `${ISSUE} : tests passés par PACT`,
    { timeout: 60_000 },
  );
  await expect(tester).not.toHaveAttribute('data-state', 'working');
  await expect(dev).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await expect
    .poll(async () => (await h.saved()).runs[0]?.stage, { timeout: 30_000 })
    .toMatch(/^(polish|pr)$/);

  // Every step is said once in the journal, as an action to the orchestrator (sc.3).
  const state = await h.saved();
  const steps = state.exchanges.messages.filter((m) => m.kind === 'stage');
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.some((m) => m.text.includes(ISSUE))).toBe(true);
  expect(state.runs[0]?.history.length).toBeGreaterThan(0);

  // The stage shows on the row of the agents (sc.4).
  await expect(page.getByText(/Étape (test|dev|polish|pr)/).first()).toBeVisible();

  // Nothing written in the repository, nothing changed in git status (sc.5, FR-011).
  await expect(readFile(join(h.repo, '.pact', 'workflow.yaml'), 'utf8')).rejects.toThrow();
  expect(git(h.repo, 'status', '--porcelain', '--', '.pact/workflow.yaml')).toBe('');
  expect(git(h.repo, 'ls-tree', '-r', 'main', '--name-only')).not.toContain('workflow.yaml');
});
