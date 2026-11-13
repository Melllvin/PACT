import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './launch-app';
import { agentWorktree, createRepo, git, typeIn } from './workspace';

// 010 — what the e2e of the workflows share: a repository with a bare remote, the contractual fake `gh`,
// the fake CLI, a ready issue and a team of an orchestrator, a dev and a test (as us54-polish.spec.ts).

export const ISSUE = '0012-connexion';
const REMOTE = 'https://github.com/pact/e2e';
const TESTS = 'export const t = 1;\n';

export type SavedRun = {
  issueId: string;
  oid: string;
  stage: string;
  status: string;
  entries: Record<string, number>;
  history: { stage: string }[];
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(prefix: string) {
  const { root, repo } = await createRepo(prefix, { 'README.md': '# test\n' });
  const bare = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', 'origin', 'main');
  const ghState = join(root, 'gh-state.json');
  const ghChecks = join(root, 'gh-checks.json');
  await writeFile(ghChecks, '{}');
  await writeFile(
    ghState,
    JSON.stringify({ remote: REMOTE, gitRemote: bare, prs: {}, required: [] }),
  );
  const env = () => ({
    PACT_FAKE_CLI: FAKE_CLI,
    PACT_FAKE_NODE: process.execPath,
    PACT_FAKE_GH: FAKE_GH,
    FAKE_GH_STATE: ghState,
    FAKE_GH_LOG: join(root, 'gh.log'),
    FAKE_GH_CHECKS: ghChecks,
    PACT_CI_POLL_MS: '2000',
    FAKE_CLI_SCENARIO: scenarioPath('workflow-default'),
  });
  const self = {
    root,
    repo,
    launched: undefined as LaunchedApp | undefined,
    env,
    async close() {
      await self.launched?.close();
      self.launched = undefined;
      await rm(root, { recursive: true, force: true });
    },
    /** The saved workspace: what a restart would find. */
    async saved(): Promise<{
      runs: SavedRun[];
      loops: { state: string; round: number }[];
      exchanges: { messages: { kind: string; text: string; to: string }[] };
      issues: { id: string; state: string }[];
    }> {
      const dir = join(self.launched?.userDataDir ?? '', 'workspaces');
      const [file] = await readdir(dir);
      const text = await readFile(join(dir, file ?? ''), 'utf8');
      const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
      return { runs: [], ...data } as never;
    },
    /** Opens the repository, writes a ready issue and the test command, relaunches. */
    async openWithIssue(): Promise<Page> {
      self.launched = await launchApp({ env: env() });
      let page = await self.launched.app.firstWindow();
      await answerFolderPickers(self.launched.app, repo);
      await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
      await expect(page.getByRole('button', { name: /Ajouter des agents/ })).toBeVisible();
      const userDataDir = self.launched.userDataDir;
      await self.launched.close({ keepData: true });
      const dir = join(userDataDir, 'workspaces');
      const [file] = await readdir(dir);
      const path = join(dir, file ?? '');
      const content = JSON.parse(await readFile(path, 'utf8')) as { data: Record<string, unknown> };
      const issue = {
        id: ISSUE,
        title: 'Connexion',
        path: `.pact/issues/${ISSUE}.md`,
        state: 'ready',
        remote: null,
        trace: { branch: null, agents: [], pr: null },
      };
      await writeFile(
        path,
        JSON.stringify({
          ...content,
          data: { ...content.data, issues: [issue], testCommand: 'git --version' },
        }),
      );
      self.launched = await launchApp({ userDataDir, env: env() });
      page = await self.launched.app.firstWindow();
      return page;
    },
    /** An orchestrator, a dev and a test, from the detailed launcher. */
    async launchTeam(page: Page) {
      await page.getByRole('button', { name: /Ajouter des agents/ }).click();
      const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
      const plus = quick
        .getByRole('group', { name: 'Faux CLI' })
        .getByRole('button', { name: /^Ajouter un / });
      await plus.click();
      await plus.click();
      await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
      const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
      const agents = detailed.getByRole('list', { name: 'Agents' }).getByRole('listitem');
      const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
      const pick = (n: number) =>
        agents
          .nth(n)
          .getByRole('button', { name: /^Faux CLI/ })
          .click();
      await pick(0);
      await inspector.getByRole('checkbox', { name: /Orchestrateur/ }).click();
      await pick(1);
      await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('dev');
      await pick(2);
      await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('test');
      await detailed.getByRole('button', { name: 'Lancer 3 agents' }).click();
      await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
      const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
      const dev = page.getByRole('article', { name: /^Faux CLI 2,/ });
      const tester = page.getByRole('article', { name: /^Faux CLI 3,/ });
      for (const tile of [lead, dev, tester]) {
        await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
      }
      return { lead, dev, tester };
    },
    call: (page: Page, lead: Locator, tool: string, args: Record<string, unknown>) =>
      typeIn(page, lead, `${tool}|${JSON.stringify(args)}`),
    /** What the agents would have done: tests committed by the tester, then by the dev, with the code. */
    async work() {
      const devTree = agentWorktree(repo, 2);
      const testTree = agentWorktree(repo, 3);
      await mkdir(join(testTree, 'tests'), { recursive: true });
      await writeFile(join(testTree, 'tests', 'connexion.test.ts'), TESTS);
      git(testTree, 'add', '-A');
      git(testTree, 'commit', '-m', 'test: connexion');
      await mkdir(join(devTree, 'tests'), { recursive: true });
      await mkdir(join(devTree, 'src'), { recursive: true });
      await writeFile(join(devTree, 'tests', 'connexion.test.ts'), TESTS);
      await writeFile(join(devTree, 'src', 'connexion.ts'), 'export const c = 1;\n');
      git(devTree, 'add', '-A');
      git(devTree, 'commit', '-m', 'feat: connexion');
    },
  };
  return self;
}
