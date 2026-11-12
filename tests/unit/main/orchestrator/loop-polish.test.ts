import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopService } from '../../../../src/main/orchestrator/loop-service';
import { deliveryGate } from '../../../../src/shared/delivery';
import {
  DEFAULT_TEST_PATHS,
  type Agent,
  type Issue,
  type Workspace,
} from '../../../../src/shared/model';
import type { HandoffReport } from '../../../../src/shared/report';
import type { TestRun } from '../../../../src/shared/review';

// 008 T054 — US5 « Peaufiner sans ajouter » (sc.1 à 6, research R23 and P2): after the proof, the
// loop polishes `polishPasses` times; a pass is a dev instruction, a verdict of the tester and a
// proof of PACT on the end commit; it has its own counter and never touches the rounds.
//
// RED until T058. Assumed API (contracts/mcp-tools.md `polish_pass`, data-model):
//   - `loops.polish(workspaceId, issueId, notes?)` resolves `{ pass, total, sent }` (`pass` = k, the
//     pass that starts, 1-based; `sent` = [{ agentId: <dev>, kind: 'instruction' }]) and rejects
//     (Error with a reason) out of `polishing`, or while a pass runs.
//   - A pass opens a round of `kind: 'polish'` in `loop.rounds`; `loop.round` and the rounds of
//     `kind: 'round'` are left as they are (FR-023).
//   - While `polishing`, `report()` and `testRun()` find the loop as they do while `running`.
//   - The end of a pass is the proof (the tests of PACT passed on a clean head) after an `accepted`
//     of the tester: `loop.polish.done` + 1, the proof on the polish round; the last pass moves
//     the loop to `accepted`.
//   - `loop.polish.restarted` = the current pass already resumed once after a `defects` (P2); it is
//     false again at the start of the next pass.
//   - The instruction to the dev is a `deps.message` draft `{ to: dev, kind: 'instruction', text }`
//     whose text holds `polishBrief`, the `notes` and the fixed sentence of R23.
// Green already (behaviour in place, kept as a guard): sc.1, and the barrier « Passe k sur N à finir »
// of `deliveryGate` (sc.2, second test), the move to `polishing` after the proof.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(n)}`,
  worktreePath: `/w/.worktrees/claude-code-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'awaiting-prompt',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  pause: null,
  effort: null,
  ...overrides,
});

const TREE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const POLISHED_HEAD = 'd'.repeat(40);
const POLISHED_TREE = 'e'.repeat(40);
const ISSUE = '0012-connexion';
const FIXED_SENTENCE = 'Aucune nouvelle fonctionnalité : corrige seulement ce qui est demandé';

const lead = agent(1, { role: 'orchestrator' });
const dev = agent(2, { role: 'dev', model: 'sonnet', branch: 'feat/connexion' });
const tester = agent(3, { role: 'test' });

const issue: Issue = {
  id: ISSUE,
  title: 'Connexion',
  path: `.pact/issues/${ISSUE}.md`,
  state: 'ready',
  remote: null,
  trace: { branch: null, agents: [], pr: null },
};

const settings = (over: Record<string, unknown> = {}) => ({
  auto: false,
  mergeMode: 'squash',
  maxRounds: 3,
  polishPasses: 2,
  polishBrief: 'Renomme les variables à une lettre',
  ...over,
});

const base = (): Workspace =>
  ({
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [lead, dev, tester],
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    testCommand: 'npm test',
    integrationRequests: [],
    delivery: settings(),
    deliveries: [],
    roleProfiles: {},
    issues: [issue],
    loops: [],
    testPaths: [...DEFAULT_TEST_PATHS],
    publishRequests: [],
    exchanges: { messages: [], escalations: [] },
    lastOpenedAt: '2026-11-03T00:00:00.000Z',
    status: 'available',
  }) as Workspace;

let current: Workspace;
/** What the worktree of the dev holds: moved by a test to say « the dev committed its polish ». */
let head: string;
let tree: string;
const notify = vi.fn();
const message = vi.fn((_workspaceId: string, _draft: Record<string, unknown>) =>
  Promise.resolve({}),
);

const deps = () => ({
  workspaces: {
    get: (id: string) => (id === current.id ? current : undefined),
    list: () => [current],
    update: (_id: string, change: (ws: Workspace) => Workspace) => {
      current = change(current);
      return Promise.resolve(current);
    },
  },
  git: {
    snapshot: vi.fn((cwd: string) =>
      Promise.resolve({ commit: 'c', tree: cwd === dev.worktreePath ? tree : TREE }),
    ),
    changedFiles: vi.fn(() => Promise.resolve([])),
    mergeBase: vi.fn((_cwd: string, _a: string, b: string) => Promise.resolve(`base-${b}`)),
    revParse: vi.fn(() => Promise.resolve(head)),
    treeOf: vi.fn(() => Promise.resolve(tree)),
  },
  review: {
    testPlan: vi.fn((agentId: string) =>
      Promise.resolve({
        target: { agentId, cwd: dev.worktreePath, port: dev.port },
        command: 'npm test',
        tree,
      }),
    ),
  },
  tests: {
    run: vi.fn((target: { agentId: string }, command: string, runTree: string) =>
      Promise.resolve<TestRun>({
        agentId: target.agentId,
        command,
        tree: runTree,
        status: 'running',
        passedCount: null,
        outputTail: '',
      }),
    ),
  },
  agents: { escalate: vi.fn(() => Promise.resolve()) },
  notify,
  message,
});

let d: ReturnType<typeof deps>;
let loops: LoopService;

beforeEach(() => {
  current = base();
  head = HEAD;
  tree = TREE;
  notify.mockClear();
  message.mockClear();
  d = deps();
  loops = new LoopService(d);
});

const report = (over: Partial<HandoffReport> = {}): HandoffReport => ({
  issue: ISSUE,
  status: 'done',
  summary: 'Fait',
  files: ['src/connexion.ts'],
  checks: [{ command: 'npm test', exitCode: 0 }],
  questions: [],
  ...over,
});
const defects = report({
  status: 'defects',
  verdict: { result: 'defects', defects: ['Le nom `x` reste à une lettre'] },
});
const accepted = report({ verdict: { result: 'accepted', defects: [] } });

const finished = (status: TestRun['status'], runTree = tree): TestRun => ({
  agentId: dev.id,
  command: 'npm test',
  tree: runTree,
  status,
  passedCount: null,
  outputTail: '',
});

/** `polish_pass` of the loop (assumed API, see the head of the file): not typed yet, hence the cast. */
const polish = (workspaceId: string, issueId: string, notes?: string) =>
  (
    loops as unknown as {
      polish(
        workspaceId: string,
        issueId: string,
        notes?: string,
      ): Promise<{ pass: number; total: number; sent: { agentId: string; kind: string }[] }>;
    }
  ).polish(workspaceId, issueId, notes);

const loop = () => current.loops[0];
const issueState = () => current.issues[0]?.state;
const kinds = () => notify.mock.calls.map(([, event]) => (event as { kind: string }).kind);
const toDev = () =>
  message.mock.calls.map(([, draft]) => draft).filter((draft) => draft.to === dev.id);
const roundsOfKind = (kind: string) => loop()?.rounds.filter((r) => r.kind === kind) ?? [];
const configure = (over: Record<string, unknown> = {}) => {
  current = { ...current, delivery: settings(over) } as Workspace;
};

/** The loop up to the proof: `polishing` with the passes of the project. */
async function proved() {
  await loops.start('w1', { issue: ISSUE, dev: dev.id, test: tester.id });
  await loops.report(tester.id, accepted);
  await loops.testRun(finished('passed'));
}

/** The dev committed its polish: the head and the tree of its worktree moved. */
const devCommits = () => {
  head = POLISHED_HEAD;
  tree = POLISHED_TREE;
};

/** A pass from its start to its end: instruction, the dev commits, verdict `accepted`, proof. */
async function wholePass(notes?: string) {
  await polish('w1', ISSUE, notes);
  devCommits();
  await loops.report(tester.id, accepted);
  await loops.testRun(finished('passed', POLISHED_TREE));
}

describe('sc.1 — 0 passes: the delivery can be asked at once', () => {
  it('Given 0 passes, When the verdict is accepted and PACT lays the proof, Then the loop is accepted with no polish and the gate lets the request through', async () => {
    configure({ polishPasses: 0 });

    await proved();

    expect(loop()).toMatchObject({ state: 'accepted', polish: null });
    expect(
      deliveryGate({
        issue: ISSUE,
        loopState: loop()?.state ?? null,
        head: HEAD,
        verdictCommit: HEAD,
        proofCommit: HEAD,
        uncommitted: [],
        missingTests: [],
        polish: loop()?.polish ?? null,
        inFlight: null,
        unverified: false,
      }),
    ).toEqual({ ok: true });
  });

  it('Given 0 passes, When polish_pass is called, Then it is refused: the loop is not polishing', async () => {
    configure({ polishPasses: 0 });
    await proved();
    // The instruction to fix the tests is sent at the first report of the tester (007 FR-021): not a polish.
    message.mockClear();

    await expect(polish('w1', ISSUE)).rejects.toThrow();

    expect(toDev().filter((m) => m.kind === 'instruction')).toHaveLength(0);
  });
});

describe('sc.2 — 2 passes: no delivery until both are done', () => {
  it('Given 2 passes, When the verdict is accepted and the proof laid, Then the loop polishes with its own counter, the issue stays in progress', async () => {
    await proved();

    expect(loop()).toMatchObject({
      state: 'polishing',
      polish: { done: 0, total: 2, restarted: false },
    });
    expect(issueState()).toBe('in-progress');
  });

  it('Given 2 passes none finished, When the delivery is asked, Then it is refused and the reason says « Passe 1 sur 2 à finir. »', async () => {
    await proved();

    const gate = deliveryGate({
      issue: ISSUE,
      loopState: loop()?.state ?? null,
      head: HEAD,
      verdictCommit: HEAD,
      proofCommit: HEAD,
      uncommitted: [],
      missingTests: [],
      polish: loop()?.polish ?? null,
      inFlight: null,
      unverified: false,
    });

    expect(gate).toEqual({ ok: false, reason: 'Passe 1 sur 2 à finir.' });
  });

  it('Given 2 passes and one finished, When the delivery is asked, Then the reason says « Passe 2 sur 2 à finir. », and after the second the loop is accepted and the gate opens', async () => {
    await proved();
    await wholePass();
    expect(loop()).toMatchObject({ state: 'polishing', polish: { done: 1, total: 2 } });

    const gateAfter = (
      polish: { done: number; total: number } | null,
      state: string | undefined,
      at: string,
    ) =>
      deliveryGate({
        issue: ISSUE,
        loopState: state ?? null,
        head: at,
        verdictCommit: at,
        proofCommit: at,
        uncommitted: [],
        missingTests: [],
        polish,
        inFlight: null,
        unverified: false,
      });
    expect(gateAfter(loop()?.polish ?? null, loop()?.state, POLISHED_HEAD)).toEqual({
      ok: false,
      reason: 'Passe 2 sur 2 à finir.',
    });

    await wholePass();

    expect(loop()).toMatchObject({ state: 'accepted', polish: { done: 2, total: 2 } });
    expect(gateAfter(loop()?.polish ?? null, loop()?.state, POLISHED_HEAD)).toEqual({ ok: true });
  });
});

describe('sc.3 — the end of a pass: tester, proof on the end commit, own counter', () => {
  it('Given a pass started, When the tester says accepted, Then the pass is not over: PACT runs its tests on the dev’s tree and the counter waits for the proof', async () => {
    await proved();
    d.tests.run.mockClear();
    await polish('w1', ISSUE);
    devCommits();

    await loops.report(tester.id, accepted);

    expect(d.tests.run).toHaveBeenCalledWith(
      { agentId: dev.id, cwd: dev.worktreePath, port: dev.port },
      'npm test',
      POLISHED_TREE,
    );
    expect(loop()?.polish).toMatchObject({ done: 0, total: 2 });
  });

  it('Given the tests of PACT passing on the end commit, When the pass ends, Then the proof names that commit, the counter of passes advances and the rounds are untouched', async () => {
    await proved();
    const roundBefore = loop()?.round;
    const roundsBefore = roundsOfKind('round').length;

    await wholePass();

    expect(loop()).toMatchObject({ state: 'polishing', polish: { done: 1, total: 2 } });
    expect(loop()?.round).toBe(roundBefore);
    expect(roundsOfKind('round')).toHaveLength(roundsBefore);
    const pass = roundsOfKind('polish');
    expect(pass).toHaveLength(1);
    expect(pass[0]?.proof).toMatchObject({ tree: POLISHED_TREE, commit: POLISHED_HEAD });
    expect(
      pass[0]?.reports.some((r) => r.role === 'test' && r.verdict?.result === 'accepted'),
    ).toBe(true);
    expect(issueState()).toBe('in-progress');
  });

  it('Given a run of the tests on a tree that is no longer the head, When it passes, Then the pass does not count', async () => {
    await proved();
    await polish('w1', ISSUE);
    devCommits();
    await loops.report(tester.id, accepted);

    await loops.testRun(finished('passed', TREE));

    expect(loop()?.polish).toMatchObject({ done: 0 });
  });

  it('Given a pass running, When polish_pass is called again, Then it is refused: one pass at a time', async () => {
    await proved();
    await polish('w1', ISSUE);
    message.mockClear();

    await expect(polish('w1', ISSUE)).rejects.toThrow();

    expect(message).not.toHaveBeenCalled();
    expect(roundsOfKind('polish')).toHaveLength(1);
  });

  it('Given a loop still running its rounds, When polish_pass is called, Then it is refused', async () => {
    await loops.start('w1', { issue: ISSUE, dev: dev.id, test: tester.id });

    await expect(polish('w1', ISSUE)).rejects.toThrow();
  });

  it('Given the proof of the polish pass, When it is laid, Then the tester’s reports of the pass reach the orchestrator like any report', async () => {
    await proved();
    notify.mockClear();

    await wholePass();

    expect(kinds()).toContain('report');
  });
});

describe('sc.4 — the instruction of a pass: precise, and no new feature', () => {
  it('Given a project brief and notes, When a pass starts, Then the dev gets ONE instruction with the brief, the notes and the ban on any new feature, and the call says who got it', async () => {
    await proved();
    message.mockClear();

    const started = await polish('w1', ISSUE, 'Et aussi les commentaires obsolètes');

    expect(started).toMatchObject({
      pass: 1,
      total: 2,
      sent: [{ agentId: dev.id, kind: 'instruction' }],
    });
    const instructions = toDev().filter((m) => m.kind === 'instruction');
    expect(instructions).toHaveLength(1);
    const text = String(instructions[0]?.text);
    expect(text).toContain('Renomme les variables à une lettre');
    expect(text).toContain('Et aussi les commentaires obsolètes');
    expect(text).toContain(FIXED_SENTENCE);
    expect(message).toHaveBeenCalledWith('w1', expect.objectContaining({ from: 'pact' }));
  });

  it('Given no notes and no brief, When a pass starts, Then the instruction still carries the ban on any new feature', async () => {
    configure({ polishBrief: '' });
    await proved();
    message.mockClear();

    await polish('w1', ISSUE);

    expect(String(toDev().find((m) => m.kind === 'instruction')?.text)).toContain(FIXED_SENTENCE);
  });

  it('Given a 2000-char project instruction AND 2000-char notes, When a pass starts, Then the fixed ban survives in full and the text stays within the send limit (P2, R23)', async () => {
    configure({ polishBrief: 'b'.repeat(2000) });
    await proved();
    message.mockClear();

    await polish('w1', ISSUE, 'n'.repeat(2000));

    const text = String(toDev().find((m) => m.kind === 'instruction')?.text);
    expect(text).toContain(FIXED_SENTENCE);
    expect(text).toContain('b'.repeat(2000));
    expect(text).toContain('n'.repeat(2000));
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it('Given the second pass, When it starts, Then it is numbered 2 on 2', async () => {
    await proved();
    await wholePass();

    await expect(polish('w1', ISSUE)).resolves.toMatchObject({ pass: 2, total: 2 });
  });

  it('Given a journal that fails, When a pass starts, Then the pass is opened anyway and the call says nobody got the instruction', async () => {
    await proved();
    message.mockRejectedValueOnce(new Error('journal en panne'));

    const started = await polish('w1', ISSUE);

    expect(started.sent).toEqual([]);
    expect(roundsOfKind('polish')).toHaveLength(1);
  });
});

describe('sc.5 — defects in a pass: the same pass resumes, no round counted (P2)', () => {
  it('Given a pass running, When the tester says defects, Then the dev gets them as a verdict, the same pass goes on and no round, no pass is counted', async () => {
    await proved();
    await polish('w1', ISSUE);
    message.mockClear();
    const roundBefore = loop()?.round;

    await loops.report(tester.id, defects);

    expect(loop()).toMatchObject({
      state: 'polishing',
      round: roundBefore,
      polish: { done: 0, total: 2, restarted: true },
    });
    expect(roundsOfKind('round')).toHaveLength(1);
    expect(roundsOfKind('polish')).toHaveLength(1);
    const verdicts = toDev().filter((m) => m.kind === 'verdict');
    expect(verdicts).toHaveLength(1);
    expect(String(verdicts[0]?.text)).toContain('Le nom `x` reste à une lettre');
    expect(issueState()).toBe('in-progress');
  });

  it('Given the loop at the last round of the ceiling, When a pass gets its first defects, Then it resumes: the ceiling of rounds is not a ceiling of polish', async () => {
    configure({ maxRounds: 2 });
    await loops.start('w1', { issue: ISSUE, dev: dev.id, test: tester.id });
    await loops.report(tester.id, report({ verdict: { result: 'defects', defects: ['a'] } }));
    await loops.next('w1', ISSUE);
    await loops.report(tester.id, accepted);
    await loops.testRun(finished('passed'));
    expect(loop()).toMatchObject({ state: 'polishing', round: 2 });
    await polish('w1', ISSUE);

    await loops.report(tester.id, defects);

    expect(loop()).toMatchObject({ state: 'polishing', round: 2 });
    expect(issueState()).toBe('in-progress');
  });

  it('Given a pass resumed once, When the pass ends well, Then the counter advances and the next pass starts with a fresh chance', async () => {
    await proved();
    await polish('w1', ISSUE);
    await loops.report(tester.id, defects);
    devCommits();
    await loops.report(tester.id, accepted);
    await loops.testRun(finished('passed', POLISHED_TREE));
    expect(loop()?.polish).toMatchObject({ done: 1, total: 2 });

    await polish('w1', ISSUE);
    await loops.report(tester.id, defects);

    expect(loop()).toMatchObject({
      state: 'polishing',
      polish: { done: 1, total: 2, restarted: true },
    });
  });
});

describe('sc.6 — passes exhausted with defects: the user decides, nothing is merged (P2)', () => {
  it('Given a pass already resumed, When the tester says defects again on the same pass, Then the loop escalates to the user and the issue too', async () => {
    await proved();
    await polish('w1', ISSUE);
    await loops.report(tester.id, defects);

    await loops.report(tester.id, defects);

    expect(loop()?.state).toBe('escalated');
    expect(issueState()).toBe('escalated');
    expect(kinds()).toContain('loop');
    const last = notify.mock.calls.at(-1)?.[1] as { kind: string; summary: string };
    expect(last).toMatchObject({ kind: 'loop' });
    expect(last.summary).toContain('l’utilisateur décide');
  });

  it('Given the escalation, When the orchestrator wants another pass or a delivery, Then polish_pass is refused and the gate refuses: nothing is merged', async () => {
    await proved();
    await polish('w1', ISSUE);
    await loops.report(tester.id, defects);
    await loops.report(tester.id, defects);

    await expect(polish('w1', ISSUE)).rejects.toThrow();
    expect(
      deliveryGate({
        issue: ISSUE,
        loopState: loop()?.state ?? null,
        head: HEAD,
        verdictCommit: HEAD,
        proofCommit: HEAD,
        uncommitted: [],
        missingTests: [],
        polish: loop()?.polish ?? null,
        inFlight: null,
        unverified: false,
      }).ok,
    ).toBe(false);
  });

  it('Given the escalation, When the user takes over, Then the loop closes and the issue stays escalated', async () => {
    await proved();
    await polish('w1', ISSUE);
    await loops.report(tester.id, defects);
    await loops.report(tester.id, defects);

    await loops.decide('w1', ISSUE, 'take-over');

    expect(loop()?.state).toBe('closed');
    expect(issueState()).toBe('escalated');
  });
});
