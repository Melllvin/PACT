import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch-app';
import { createHarness, ISSUE, type Harness } from './helpers/workflow-harness';

// 010 US1 / SC-006 end to end (T019): PACT restarted while a run is in a stage resumes it at the same
// stage and on the same version of the workflow, with no step played twice. The pause of 009 during the
// `test` stage changes no stage and is covered by workflow-service.test.ts (a pause is ignored by the engine).
//
// RED until the engine of the workflows is wired (T020 to T025).

let h: Harness;

test.beforeEach(async () => {
  h = await createHarness('pact-us61-');
});
test.afterEach(async () => {
  await h.close();
});

test('SC-006: restarted in the middle of a run, PACT finds the same stage, the same version and the same history', async () => {
  test.setTimeout(300_000);
  const page = await h.openWithIssue();
  const { lead } = await h.launchTeam(page);
  await h.work();
  await h.call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });
  await expect.poll(async () => (await h.saved()).runs.length, { timeout: 30_000 }).toBe(1);
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });

  const before = (await h.saved()).runs[0];
  expect(before?.status).toBe('active');
  const userDataDir = h.launched?.userDataDir ?? '';
  await h.launched?.close({ keepData: true });

  h.launched = await launchApp({ userDataDir, env: h.env() });
  await h.launched.app.firstWindow();
  // Time for the replay of the restart (SC-006).
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const after = (await h.saved()).runs;
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    issueId: ISSUE,
    oid: before?.oid,
    stage: before?.stage,
    status: 'active',
  });
  expect(after[0]?.history).toEqual(before?.history);
  expect(after[0]?.entries).toEqual(before?.entries);
});
