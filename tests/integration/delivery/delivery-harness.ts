import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { DeliveryService } from '../../../src/main/delivery/delivery-service';
import { GhClient, type GhRun } from '../../../src/main/delivery/gh-client';
import { GitService } from '../../../src/main/git/git-service';
import { ExchangeService } from '../../../src/main/orchestrator/exchange-service';
import { LoopService } from '../../../src/main/orchestrator/loop-service';
import { openStores } from '../../../src/main/persistence/store';
import { IntegrationService } from '../../../src/main/review/integration-service';
import { ReviewService } from '../../../src/main/review/review-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { Delivery } from '../../../src/shared/delivery';
import type { Agent, Workspace } from '../../../src/shared/model';
import type { Integration } from '../../../src/shared/review';
import { FAKE_GH } from '../../fixtures/fake-cli/paths';

// 008 phase 3 — a project as `DeliveryService` meets it: a temporary repository, a BARE REPOSITORY
// ON THE DISK for the remote, the contractual fake `gh` (tests/fixtures/fake-cli/fake-gh.mjs), and
// the real services around it. No agent process, no network, no real `gh`, no `refs/pull/*`.
//
// RED until T018 creates `src/main/delivery/delivery-service.ts`. THE API THIS HARNESS ASSUMES (the
// dev implements it; any change of it is a change of these tests, listed in the report):
//
//   new DeliveryService({
//     workspaces,       // WorkspaceService: get, list, update
//     git,              // GitService
//     gh,               // GhClient
//     loops,            // LoopService: reopen(workspaceId, issueId, reason)
//     integration,      // IntegrationService: start({ …, requestId }) for the local channel
//     exchanges,        // ExchangeService: record(workspaceId, draft)
//     deliveriesDir,    // <userData>/deliveries: the temporary worktree of each rebase
//     runTests,         // (cwd, command) => Promise<{ passed: boolean; tail: string }>: the tests of
//                       //  PACT on R, in the temporary worktree of the rebase
//     onChange?,        // (workspaceId, { deliveries, delivery }) => void   (workspace:deliveries)
//   })
//   request(workspaceId, { agentId, title, message, unverified?, requestedBy }): Promise<Delivery>
//       never throws for a refusal: the Delivery comes back `refused` with its `reason`, saved, and
//       the refusal is told (outcome `refused`). It resolves once the barriers are passed; the steps
//       `syncing` … `opening` go on in the background and are read in `workspace.deliveries`.
//   decide({ deliveryId, decision: 'validate' | 'refuse', head, reason? }): Promise<Delivery>
//       phase 3 uses it for the local channel only (« Fusionner » / « Refuser »).
//   integrationState(integration): follows the integrations started with a `requestId`.

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export const ISSUE = '0012-connexion';
export const short = (sha: string) => sha.slice(0, 7);

/** The tests of the project: red as soon as a file named FAIL is in the folder they run in. */
const CHECK_TESTS = `import { existsSync } from 'node:fs';
process.exit(existsSync('FAIL') ? 1 : 0);
`;

export type DeliveryHarness = Awaited<ReturnType<typeof createDeliveryHarness>>;

export async function createDeliveryHarness(
  options: { remote?: boolean; ghRemote?: string; ghMissing?: boolean } = {},
) {
  const withRemote = options.remote ?? true;
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-delivery-')));
  const repo = join(root, 'Mes Projets', 'Développement');
  const bare = join(root, 'origin.git');
  const userData = join(root, 'userData');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'PACT Test');
  git(repo, 'config', 'user.email', 'test@pact.dev');
  await writeFile(join(repo, 'README.md'), '# test\n');
  await writeFile(join(repo, 'check-tests.mjs'), CHECK_TESTS);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  let colleague = '';
  if (withRemote) {
    git(root, 'init', '--bare', '-b', 'main', bare);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main');
    // Another clone: what a colleague, or the forge, does to the remote.
    colleague = join(root, 'colleague');
    git(root, 'clone', '-q', bare, colleague);
    git(colleague, 'config', 'user.name', 'Colleague');
    git(colleague, 'config', 'user.email', 'colleague@pact.dev');
  }

  // ---- the fake gh ----
  const ghState = join(root, 'gh-state.json');
  const ghLogFile = join(root, 'gh.log');
  writeFileSync(
    ghState,
    JSON.stringify({
      remote: options.ghRemote ?? 'https://github.com/pact/test',
      ...(withRemote ? { gitRemote: bare } : {}),
      login: 'pact-user',
      prs: {},
      checks: {},
      required: [],
    }),
  );
  writeFileSync(ghLogFile, '');
  const ghEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('PACT_')) ghEnv[key] = value;
  }
  ghEnv.FAKE_GH_STATE = ghState;
  ghEnv.FAKE_GH_LOG = ghLogFile;

  const timeline: string[] = [];
  const ghRun: GhRun = (args, { cwd, input }) => {
    timeline.push(`gh:${args.slice(0, 2).join(' ')}`);
    if (options.ghMissing) {
      return Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    }
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [FAKE_GH, ...args],
        { cwd, env: ghEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(new Error(error.message), { stderr, code: error.code }));
          else resolve(stdout);
        },
      );
      child.stdin?.end(input ?? '');
    });
  };

  // ---- the services ----
  const stores = openStores(userData);
  const gitService = new GitService({ env: gitEnv });
  const workspaces = new WorkspaceService({ git: gitService, stores });
  const opened = await workspaces.open(repo);
  const workspaceId = opened.id;
  await workspaces.update(workspaceId, (ws) => ({ ...ws, testCommand: 'node check-tests.mjs' }));
  const exchanges = new ExchangeService({ workspaces, onChange: () => undefined });
  const notices: unknown[] = [];
  const review = new ReviewService({ git: gitService, workspaces });
  const loops = new LoopService({
    workspaces,
    git: gitService,
    review,
    tests: { run: vi.fn() },
    agents: { escalate: () => Promise.resolve() },
    notify: (_id, notice) => notices.push(notice),
    message: (id, draft) => exchanges.record(id, draft),
  });
  const integrations: Integration[] = [];
  // Built before the service that follows it; the app wires them the same way.
  const followers: ((integration: Integration) => void)[] = [];
  const integration = new IntegrationService({
    git: gitService,
    workspaces,
    agents: { close: () => Promise.resolve() },
    prompts: { sendPrompt: () => Promise.resolve(undefined) },
    integrationsDir: join(userData, 'integrations'),
    conflictsDir: join(userData, 'conflicts'),
    onState: (state) => {
      integrations.push(state);
      for (const follow of followers) follow(state);
    },
  });
  const changes: unknown[] = [];

  // What PACT's tests saw: where they ran, on which commit, and the gate that holds them.
  const testRuns: { cwd: string; head: string; command: string }[] = [];
  let gate: Promise<void> | null = null;
  const holdTests = () => {
    let release = () => {};
    gate = new Promise<void>((resolve) => {
      release = () => {
        gate = null;
        resolve();
      };
    });
    return { release };
  };
  const runTests = async (cwd: string, command: string) => {
    timeline.push('tests');
    testRuns.push({ cwd, head: git(cwd, 'rev-parse', 'HEAD'), command });
    if (gate) await gate;
    const passed = await new Promise<boolean>((resolve) => {
      execFile('sh', ['-c', command], { cwd, env: gitEnv }, (error) => {
        resolve(error === null);
      });
    });
    return { passed, tail: passed ? '' : 'tests rouges' };
  };

  // The order of the steps, whatever the service calls them from: wrap, then call through.
  const original = {
    fetchRefs: gitService.fetchRefs.bind(gitService),
    rebaseOnto: gitService.rebaseOnto.bind(gitService),
    pushBranch: gitService.pushBranch.bind(gitService),
  };
  const gitCalls = {
    fetchRefs: vi.spyOn(gitService, 'fetchRefs'),
    rebaseOnto: vi.spyOn(gitService, 'rebaseOnto'),
    pushBranch: vi.spyOn(gitService, 'pushBranch'),
  };
  gitCalls.fetchRefs.mockImplementation((...args) => {
    timeline.push('fetchRefs');
    return original.fetchRefs(...args);
  });
  gitCalls.rebaseOnto.mockImplementation((...args) => {
    timeline.push('rebaseOnto');
    return original.rebaseOnto(...args);
  });
  gitCalls.pushBranch.mockImplementation((...args) => {
    timeline.push('pushBranch');
    return original.pushBranch(...args);
  });

  const gh = new GhClient({ run: ghRun, cwd: repo });
  const delivery = new DeliveryService({
    workspaces,
    git: gitService,
    gh,
    loops,
    integration,
    exchanges,
    deliveriesDir: join(userData, 'deliveries'),
    runTests,
    onChange: (_id: string, change: unknown) => changes.push(change),
  });
  followers.push((state) => {
    (delivery as unknown as { integrationState(i: Integration): void }).integrationState(state);
  });

  // ---- the project ----
  const workspace = (): Workspace => {
    const ws = workspaces.get(workspaceId);
    if (!ws) throw new Error('workspace gone');
    return ws;
  };
  let nextPosition = 1;
  const agents = new Map<string, Agent>();

  /** An agent with its own worktree and branch, `done` and idle. */
  async function addAgent(
    role: 'orchestrator' | 'dev' | 'test' | null,
    { branch, base = 'main', state = 'done' }: { branch: string; base?: string; state?: string } = {
      branch: `agent/${randomUUID().slice(0, 8)}`,
    },
  ): Promise<Agent> {
    const position = nextPosition++;
    const worktreePath = join(root, 'trees', `agent-${String(position)}`);
    await mkdir(dirname(worktreePath), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath, base);
    git(worktreePath, 'config', 'user.name', 'PACT Test');
    git(worktreePath, 'config', 'user.email', 'test@pact.dev');
    const agent = {
      id: randomUUID(),
      workspaceId,
      position,
      color: 'purple',
      cliId: 'fake',
      model: null,
      permissionLevel: 'always-allow',
      baseBranch: base,
      branch,
      worktreePath,
      port: 3000 + position,
      startCommand: null,
      sessionId: null,
      initialPrompt: null,
      alwaysAllowRules: [],
      state,
      lastError: null,
      scheduledResume: null,
      review: { seen: {}, comments: [] },
      role,
      launchedBy: null,
      closedWhileWorking: false,
      effort: null,
    } as Agent;
    await workspaces.update(workspaceId, (ws) => ({ ...ws, agents: [...ws.agents, agent] }));
    agents.set(agent.id, agent);
    return agent;
  }

  const setAgentState = (agent: Agent, state: string) =>
    workspaces.update(workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === agent.id ? ({ ...a, state } as Agent) : a)),
    }));

  /** Writes `files` in the worktree of `agent` and commits them; `null` deletes. Returns the commit. */
  async function commit(agent: Agent, files: Record<string, string | null>, message = 'work') {
    for (const [path, content] of Object.entries(files)) {
      const full = join(agent.worktreePath, path);
      if (content === null) await rm(full, { force: true });
      else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      }
    }
    git(agent.worktreePath, 'add', '-A');
    git(agent.worktreePath, 'commit', '-q', '-m', message);
    return git(agent.worktreePath, 'rev-parse', 'HEAD');
  }

  /** The colleague pushes `files` on `branch` of the remote (created from main when new). */
  function pushToOrigin(branch: string, files: Record<string, string>, message = 'upstream') {
    git(colleague, 'fetch', '-q', 'origin');
    if (tryGit(colleague, 'rev-parse', '--verify', '--quiet', `origin/${branch}`) === null) {
      git(colleague, 'checkout', '-q', '-B', branch, 'origin/main');
    } else git(colleague, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSyncFor(join(colleague, path));
      writeFileSync(join(colleague, path), content);
    }
    git(colleague, 'add', '-A');
    git(colleague, 'commit', '-q', '-m', message);
    git(colleague, 'push', '-q', 'origin', branch);
    git(repo, 'fetch', '-q', 'origin');
    return git(colleague, 'rev-parse', 'HEAD');
  }

  /**
   * A loop of `dev` and `tester` accepted by the book: a verdict `accepted` on the head of the dev,
   * PACT's proof on that same head, the issue still in progress (FR-007).
   */
  async function acceptLoop(
    dev: Agent,
    tester: Agent,
    {
      issue = ISSUE,
      published = null,
      state = 'accepted',
      verdictCommit,
      proofCommit,
    }: {
      issue?: string;
      published?: number | null;
      state?: string;
      verdictCommit?: string;
      proofCommit?: string;
    } = {},
  ) {
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');
    const tree = git(dev.worktreePath, 'rev-parse', 'HEAD^{tree}');
    const at = new Date().toISOString();
    const loop = {
      issueId: issue,
      devAgentId: dev.id,
      testAgentId: tester.id,
      round: 1,
      rounds: [
        {
          n: 1,
          kind: 'round',
          startedAt: at,
          reports: [
            {
              issue,
              status: 'done',
              summary: 'Les tests couvrent les critères.',
              files: [],
              checks: [{ command: 'npm test', exitCode: 0 }],
              questions: [],
              verdict: { result: 'accepted', defects: [] },
              agentId: tester.id,
              role: 'test',
              round: 1,
              at,
              commit: verdictCommit ?? head,
              dirty: false,
            },
          ],
          proof: { tree, commit: proofCommit ?? head, exitCode: 0, at },
          testerTouched: [],
        },
      ],
      state,
      polish: null,
      escalatedModel: null,
    };
    await workspaces.update(workspaceId, (ws) => ({
      ...ws,
      issues: [
        ...ws.issues.filter((i) => i.id !== issue),
        {
          id: issue,
          title: 'Connexion',
          path: `.pact/issues/${issue}.md`,
          state: 'in-progress',
          remote:
            published === null
              ? null
              : {
                  number: published,
                  url: `https://github.com/pact/test/issues/${String(published)}`,
                },
          trace: { branch: dev.branch, agents: [dev.id, tester.id], pr: null },
        },
      ],
      loops: [...ws.loops.filter((l) => l.issueId !== issue), loop as Workspace['loops'][number]],
    }));
    return loop;
  }

  /** The standard team: an orchestrator, a dev with a commit, a tester whose tests the dev holds. */
  async function team(
    suffix = 'a',
    { base = 'main', published = null as number | null, accept = true } = {},
  ) {
    const lead =
      workspace().agents.find((a) => a.role === 'orchestrator') ??
      (await addAgent('orchestrator', { branch: `lead/${suffix}` }));
    const dev = await addAgent('dev', { branch: `feat/${suffix}`, base });
    const tester = await addAgent('test', { branch: `test/${suffix}`, base });
    const tests = `tests/${suffix}.test.ts`;
    await commit(tester, { [tests]: `export const t = '${suffix}';\n` }, 'tests');
    await commit(
      dev,
      {
        [tests]: `export const t = '${suffix}';\n`,
        [`src/${suffix}.ts`]: `export const a = '${suffix}';\n`,
      },
      'feat',
    );
    const issue = `001${suffix}-${suffix}`;
    if (accept) await acceptLoop(dev, tester, { issue, published });
    return { lead, dev, tester, issue, tests };
  }

  // ---- reading ----
  const deliveries = (): Delivery[] => workspace().deliveries;
  const deliveryOf = (id: string): Delivery => {
    const found = deliveries().find((d) => d.id === id);
    if (!found) throw new Error(`delivery ${id} not saved`);
    return found;
  };
  async function until(id: string, states: string[], timeoutMs = 20_000): Promise<Delivery> {
    const start = Date.now();
    for (;;) {
      const found = deliveries().find((d) => d.id === id);
      if (found && states.includes(found.state)) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `delivery ${id} stayed ${found?.state ?? '(absent)'} instead of ${states.join('|')} (${found?.reason ?? ''})`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error(what);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const journal = () => workspace().exchanges.messages;
  type DeliveryMessage = (typeof journal extends () => infer M ? M : never)[number] & {
    delivery?: {
      id: string;
      outcome: string;
      pr?: number | { number: number };
      commit?: string;
      checks?: string[];
    };
  };
  const deliveryMessages = () =>
    journal().filter((m) => (m.kind as string) === 'delivery') as DeliveryMessage[];
  const messagesTo = (agentId: string) => journal().filter((m) => m.to === agentId);
  const ghLog = (): string[][] =>
    readFileSync(ghLogFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const ghStateNow = () =>
    JSON.parse(readFileSync(ghState, 'utf8')) as {
      prs: Record<
        string,
        { number: number; headRefOid: string; baseRefName: string; title: string; body: string }
      >;
    };
  const setGhState = (patch: Record<string, unknown>) => {
    writeFileSync(ghState, JSON.stringify({ ...ghStateNow(), ...patch }));
  };
  const remoteHead = (branch: string) =>
    withRemote ? tryGit(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) : null;
  const refsOf = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname)');

  return {
    root,
    repo,
    bare,
    userData,
    workspaceId,
    workspace,
    workspaces,
    gitService,
    delivery,
    gh,
    loops,
    integration,
    integrations,
    exchanges,
    notices,
    changes,
    timeline,
    testRuns,
    holdTests,
    gitCalls,
    addAgent,
    setAgentState,
    commit,
    pushToOrigin,
    acceptLoop,
    team,
    deliveries,
    deliveryOf,
    until,
    waitFor,
    journal,
    deliveryMessages,
    messagesTo,
    ghLog,
    ghStateNow,
    setGhState,
    remoteHead,
    refsOf,
    /** The request of the orchestrator for `dev`, as `request_delivery` makes it. */
    request: (
      devId: string,
      input: {
        title?: string;
        message?: string;
        unverified?: boolean;
        by?: 'orchestrator' | 'user';
      } = {},
    ) =>
      delivery.request(workspaceId, {
        agentId: devId,
        title: input.title ?? 'Connexion par e-mail',
        message: input.message ?? 'feat: connexion par e-mail',
        ...(input.unverified === undefined ? {} : { unverified: input.unverified }),
        requestedBy: input.by ?? 'orchestrator',
      }),
    async dispose() {
      (delivery as unknown as { dispose?: () => void }).dispose?.();
      workspaces.dispose();
      review.dispose();
      // The last writes land first.
      await new Promise((r) => setTimeout(r, 100));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function mkdirSyncFor(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) execFileSync('mkdir', ['-p', dir]);
}
