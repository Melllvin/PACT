import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('SC-006: a message that arrives while PACT is stopped is replayed at the restart: test → dev, once', async () => {
  test.setTimeout(300_000);
  const page = await h.openWithIssue();
  const { lead } = await h.launchTeam(page);
  await h.work();
  await h.call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });
  await expect.poll(async () => (await h.saved()).runs[0]?.stage, { timeout: 30_000 }).toBe('test');
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  const userDataDir = h.launched?.userDataDir ?? '';
  await h.launched?.close({ keepData: true });

  // While PACT is stopped, the tester reported: the report is in its loop and in the journal.
  const dir = join(userDataDir, 'workspaces');
  const [file] = await readdir(dir);
  const path = join(dir, file ?? '');
  const content = JSON.parse(await readFile(path, 'utf8')) as {
    data: {
      agents: { id: string; role: string | null }[];
      loops: { rounds: { reports: unknown[] }[] }[];
      exchanges: { messages: unknown[] };
    };
  };
  const at = new Date().toISOString();
  const testerId = content.data.agents.find((a) => a.role === 'test')?.id ?? '';
  const leadId = content.data.agents.find((a) => a.role === 'orchestrator')?.id ?? '';
  content.data.loops[0]?.rounds[0]?.reports.push({
    issue: ISSUE,
    status: 'done',
    summary: 'Tests écrits',
    files: ['tests/connexion.test.ts'],
    checks: [],
    questions: [],
    agentId: testerId,
    role: 'test',
    round: 1,
    at,
    commit: null,
    dirty: false,
  });
  content.data.exchanges.messages.push({
    id: randomUUID(),
    at,
    from: 'pact',
    to: leadId,
    about: testerId,
    type: 'action',
    kind: 'report',
    text: 'Rapport du test',
    unreadBy: [leadId],
  });
  await writeFile(path, JSON.stringify(content));

  h.launched = await launchApp({ userDataDir, env: h.env() });
  await h.launched.app.firstWindow();
  await expect.poll(async () => (await h.saved()).runs[0]?.stage, { timeout: 30_000 }).toBe('dev');
  const run = (await h.saved()).runs[0];
  expect(run?.history.map((x) => x.outcome)).toEqual(['tests-written']);
  expect(run?.entries.dev).toBe(1);
});
