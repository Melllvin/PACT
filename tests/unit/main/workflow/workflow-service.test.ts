import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowService } from '../../../../src/main/workflow/workflow-service';
import type { RecordInput } from '../../../../src/main/orchestrator/exchange-service';
import { typeOf, type ExchangeKind, type ExchangeMessage } from '../../../../src/shared/exchanges';
import { defaultDeliverySettings } from '../../../../src/shared/delivery';
import {
  DEFAULT_TEST_PATHS,
  type Agent,
  type Issue,
  type Loop,
  type Workspace,
} from '../../../../src/shared/model';
import type { HandoffReport, StoredReport } from '../../../../src/shared/report';
import { defaultWorkflow, type Workflow } from '../../../../src/shared/workflow';

// 010 T013 and T014 — the engine of the workflows: one run per issue, on the version it started with;
// it advances on the messages of the journal of 007, writes its state before any message, and sends
// the instruction of a stage (research R5, R7, R8, R9; FR-012 to FR-014, SC-006).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ISSUE = '0012-connexion';

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

const lead = agent(1, { role: 'orchestrator' });
const dev = agent(2, { role: 'dev' });
const tester = agent(3, { role: 'test' });
const speccer = agent(4, { role: 'spec' });

const issue = (state: Issue['state'] = 'ready'): Issue => ({
  id: ISSUE,
  title: 'Connexion',
  path: `.pact/issues/${ISSUE}.md`,
  state,
  remote: null,
  trace: { branch: null, agents: [], pr: null },
});

const storedReport = (a: Agent, over: Partial<HandoffReport> = {}): StoredReport => ({
  issue: ISSUE,
  status: 'done',
  summary: 'Fait',
  files: [],
  checks: [],
  questions: [],
  agentId: a.id,
  role: a.role === 'test' ? 'test' : 'dev',
  round: 1,
  at: '2026-11-13T10:00:00.000Z',
  commit: null,
  dirty: false,
  ...over,
});

const loopOf = (state: Loop['state'], reports: StoredReport[] = []): Loop => ({
  issueId: ISSUE,
  devAgentId: dev.id,
  testAgentId: tester.id,
  round: 1,
  rounds: [
    {
      n: 1,
      startedAt: '2026-11-13T10:00:00.000Z',
      reports,
      proof: null,
      kind: 'round',
      testerTouched: [],
    },
  ],
  state,
  polish: null,
  escalatedModel: null,
});

const base = (): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [lead, dev, tester, speccer],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: 'npm test',
  integrationRequests: [],
  delivery: { ...defaultDeliverySettings(), polishPasses: 1 },
  deliveries: [],
  roleProfiles: {},
  issues: [issue()],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  exchanges: { messages: [], escalations: [] },
  workflow: { lastValid: null, error: null, readAt: null },
  runs: [],
  lastOpenedAt: '2026-11-13T00:00:00.000Z',
  status: 'available',
});

let current: Workspace;
let workflow: Workflow;
let seq: number;
/** What the service wrote, and the stage of the run at the time it wrote (state before message). */
let written: { draft: RecordInput; stageThen: string | undefined }[];

const exchanges = {
  record: vi.fn((_workspaceId: string, draft: RecordInput): Promise<ExchangeMessage> => {
    written.push({ draft, stageThen: current.runs[0]?.stage });
    return Promise.resolve(append(draft));
  }),
};

function append(draft: RecordInput): ExchangeMessage {
  seq += 1;
  const message = {
    id: uuid(1000 + seq),
    at: '2026-11-13T10:00:00.000Z',
    from: draft.from,
    to: draft.to,
    ...(draft.about === undefined ? {} : { about: draft.about }),
    type: typeOf(draft.kind),
    kind: draft.kind,
    text: draft.text,
    ...(draft.delivery === undefined ? {} : { delivery: draft.delivery }),
    ...(draft.stage === undefined ? {} : { stage: draft.stage }),
    unreadBy: draft.unreadBy ?? [draft.to],
  } as ExchangeMessage;
  current = {
    ...current,
    exchanges: { ...current.exchanges, messages: [...current.exchanges.messages, message] },
  };
  return message;
}

const make = (): WorkflowService =>
  new WorkflowService({
    workspaces: {
      get: (id: string) => (id === current.id ? current : undefined),
      list: () => [current],
      update: (_id: string, change: (ws: Workspace) => Workspace) => {
        current = change(current);
        return Promise.resolve(current);
      },
    },
    source: {
      current: () =>
        Promise.resolve({
          source: 'default' as const,
          oid: 'default' as const,
          workflow,
          ignoredLocal: [],
          phase2: [],
        }),
    },
    exchanges,
    now: () => new Date('2026-11-13T10:00:00.000Z'),
  });

let service: WorkflowService;

beforeEach(() => {
  current = base();
  workflow = defaultWorkflow(current.delivery);
  seq = 0;
  written = [];
  exchanges.record.mockClear();
  service = make();
});

/** A message of PACT to the orchestrator, written in the journal as 007 would have. */
function event(
  kind: ExchangeKind,
  about: Agent,
  extra: Partial<RecordInput> = {},
): ExchangeMessage {
  return append({ from: 'pact', to: lead.id, about: about.id, kind, text: kind, ...extra });
}

const run = () => current.runs[0];
const stageMessages = () => written.filter((w) => w.draft.kind === 'stage');
const instructions = () => written.filter((w) => w.draft.kind === 'instruction');

/** Registers the issue, with the agents of the loop in place, and puts the run on a stage. */
async function runAt(stage: string, loop?: Loop) {
  await service.register('w1', ISSUE);
  current = {
    ...current,
    loops: loop ? [loop] : current.loops,
    runs: current.runs.map((r) => ({
      ...r,
      stage,
      bindings: { tester: tester.id, dev: dev.id },
    })),
  };
  written = [];
}

describe('register', () => {
  it('creates the run on the start stage with the version of the workflow copied (R8)', async () => {
    current = { ...current, issues: [issue('proposed')] };
    const created = await service.register('w1', ISSUE);
    expect(created).toMatchObject({
      issueId: ISSUE,
      stage: 'spec',
      status: 'active',
      oid: 'default',
      workflow,
    });
    expect(current.runs).toHaveLength(1);
    expect(stageMessages()).toHaveLength(0);
  });

  it('is the same run when the issue is registered again', async () => {
    current = { ...current, issues: [issue('proposed')] };
    await service.register('w1', ISSUE);
    await service.register('w1', ISSUE);
    expect(current.runs).toHaveLength(1);
  });

  it('moves a ready issue from spec to test, state written before the stage message', async () => {
    const created = await service.register('w1', ISSUE);
    expect(created.stage).toBe('test');
    expect(run()?.history).toEqual([
      { at: '2026-11-13T10:00:00.000Z', from: 'spec', to: 'test', outcome: 'ready' },
    ]);
    const [message] = stageMessages();
    expect(message?.stageThen).toBe('test');
    expect(message?.draft).toMatchObject({
      from: 'pact',
      to: lead.id,
      kind: 'stage',
      stage: { issue: ISSUE, from: 'spec', to: 'test', outcome: 'ready' },
    });
    expect(message?.draft.text).toContain('Étape test · 0012-connexion (après spec : ready)');
    expect(message?.draft.text).toContain('lance test');
  });

  it('holds the run at spec while the issue is only proposed, then moves when it is ready', async () => {
    current = { ...current, issues: [issue('proposed')] };
    await service.register('w1', ISSUE);
    current = { ...current, issues: [issue('ready')] };
    const again = await service.register('w1', ISSUE);
    expect(again.stage).toBe('test');
    expect(current.runs).toHaveLength(1);
  });

  it('creates the run of an issue that had none (before 010) on the stage of its loop (R8)', async () => {
    current = { ...current, issues: [issue('in-progress')], loops: [loopOf('polishing')] };
    const created = await service.ensure('w1', ISSUE);
    expect(created.stage).toBe('polish');
    current = { ...base(), issues: [issue('in-progress')], loops: [loopOf('delivering')] };
    service = make();
    expect((await service.ensure('w1', ISSUE)).stage).toBe('pr');
    current = {
      ...base(),
      issues: [issue('in-progress')],
      loops: [loopOf('running', [storedReport(tester)])],
    };
    service = make();
    expect((await service.ensure('w1', ISSUE)).stage).toBe('dev');
  });
});

describe('transitions (research R5)', () => {
  it('tests written: the first report of the tester without verdict, test → dev', async () => {
    await runAt('test', loopOf('running', [storedReport(tester)]));
    await service.handle('w1', event('report', tester));
    expect(run()?.stage).toBe('dev');
    expect(stageMessages()[0]?.draft.stage).toMatchObject({
      from: 'test',
      to: 'dev',
      outcome: 'tests-written',
    });
  });

  it('done: the report of the dev, dev → test', async () => {
    await runAt('dev', loopOf('running', [storedReport(dev)]));
    await service.handle('w1', event('report', dev));
    expect(run()?.stage).toBe('test');
    expect(run()?.history.at(-1)).toMatchObject({ from: 'dev', to: 'test', outcome: 'done' });
  });

  it('defects: a verdict of the tester, test → dev', async () => {
    const verdict = storedReport(tester, {
      status: 'defects',
      verdict: { result: 'defects', defects: ['vide'] },
    });
    await runAt('test', loopOf('running', [verdict]));
    await service.handle('w1', event('report', tester));
    expect(run()?.stage).toBe('dev');
    expect(run()?.history.at(-1)?.outcome).toBe('defects');
  });

  it('accepted: only when the loop says so (PACT’s proof), never on the verdict alone', async () => {
    const verdict = storedReport(tester, { verdict: { result: 'accepted', defects: [] } });
    await runAt('test', loopOf('running', [verdict]));
    await service.handle('w1', event('report', tester));
    expect(run()?.stage).toBe('test');
    current = { ...current, loops: [loopOf('polishing', [verdict])] };
    await service.handle('w1', event('loop', dev));
    expect(run()?.stage).toBe('polish');
    expect(run()?.history.at(-1)?.outcome).toBe('accepted');
  });

  it('done on polish: the loop goes from polishing to accepted, polish → pr', async () => {
    await runAt('polish', loopOf('polishing'));
    await service.handle('w1', event('loop', dev));
    expect(run()?.stage).toBe('polish');
    current = { ...current, loops: [loopOf('accepted')] };
    await service.handle('w1', event('loop', dev));
    expect(run()?.stage).toBe('pr');
  });

  it('passes to 0: the polish stage emits done on entry, test → polish → pr in one move', async () => {
    workflow = defaultWorkflow({ ...current.delivery, polishPasses: 0 });
    await runAt('test', loopOf('accepted'));
    current = { ...current, runs: current.runs.map((r) => ({ ...r, workflow })) };
    await service.handle('w1', event('loop', dev));
    expect(run()?.stage).toBe('pr');
    expect(run()?.history.map((h) => `${h.from}>${h.to}:${h.outcome}`)).toEqual([
      'spec>test:ready',
      'test>polish:accepted',
      'polish>pr:done',
    ]);
    expect(stageMessages()).toHaveLength(1);
  });

  it.each(['ci-red', 'tests-failed', 'conflicted', 'user-refused'])(
    'pr → dev on %s: a return, the same run, not a new one',
    async (outcome) => {
      await runAt('pr', loopOf('delivering'));
      await service.handle(
        'w1',
        event('delivery', dev, { delivery: { id: uuid(500), outcome: outcome as 'ci-red' } }),
      );
      expect(run()?.stage).toBe('dev');
      expect(current.runs).toHaveLength(1);
      expect(run()?.history.at(-1)).toMatchObject({ from: 'pr', to: 'dev', outcome });
    },
  );

  it('merged on the arrival: the run is finished and the orchestrator hears it', async () => {
    await runAt('pr', loopOf('delivering'));
    await service.handle(
      'w1',
      event('delivery', dev, { delivery: { id: uuid(500), outcome: 'merged' } }),
    );
    expect(run()?.status).toBe('finished');
    expect(run()?.stage).toBe('pr');
    expect(stageMessages()[0]?.draft.text).toBe(`Workflow terminé · ${ISSUE}`);
  });

  it('a result without transition changes nothing: refused and dropped stay on pr, no message', async () => {
    await runAt('pr', loopOf('delivering'));
    const before = run();
    await service.handle(
      'w1',
      event('delivery', dev, { delivery: { id: uuid(500), outcome: 'refused' } }),
    );
    await service.handle(
      'w1',
      event('delivery', dev, { delivery: { id: uuid(500), outcome: 'dropped' } }),
    );
    expect(run()).toMatchObject({ stage: 'pr', status: 'active', history: before?.history });
    expect(written).toHaveLength(0);
  });

  it('a report of the wrong role for the stage is no result (the dev reports while on test)', async () => {
    await runAt('test', loopOf('running', [storedReport(dev)]));
    await service.handle('w1', event('report', dev));
    expect(run()?.stage).toBe('test');
    expect(written).toHaveLength(0);
  });

  it('a pause of 009 moves nothing: usage-paused then usage-resumed', async () => {
    await runAt('dev', loopOf('running'));
    const before = run();
    await service.handle('w1', event('usage-save', dev));
    await service.handle('w1', event('usage-paused', dev));
    await service.handle('w1', event('usage-resumed', dev));
    expect(run()).toMatchObject({ stage: before?.stage, status: 'active' });
    expect(written).toHaveLength(0);
  });
});

describe('replay and restart (research R8, SC-006)', () => {
  it('the same message handled twice has no second effect (lastMessageId)', async () => {
    await runAt('dev', loopOf('running', [storedReport(dev)]));
    const message = event('report', dev);
    await service.handle('w1', message);
    await service.handle('w1', message);
    expect(run()?.stage).toBe('test');
    expect(run()?.history.filter((h) => h.from === 'dev')).toHaveLength(1);
    expect(stageMessages()).toHaveLength(1);
    expect(run()?.lastMessageId).toBe(message.id);
  });

  it('a new service on the same state replays the messages after lastMessageId', async () => {
    await runAt('dev', loopOf('running', [storedReport(dev)]));
    const first = event('report', dev);
    await service.handle('w1', first);
    // The app stops after the message below was written but before the engine saw it.
    current = { ...current, loops: [loopOf('running', [storedReport(tester)])] };
    event('report', tester);
    const restarted = make();
    await restarted.resume();
    expect(run()?.stage).toBe('dev');
    expect(run()?.history.map((h) => h.outcome)).toEqual(['ready', 'done', 'tests-written']);
    // And what it had already seen is not played again.
    await restarted.resume();
    expect(run()?.history).toHaveLength(3);
  });

  it('keeps the stage and the version of a run through a restart', async () => {
    await runAt('dev', loopOf('running'));
    const saved = JSON.parse(JSON.stringify(run())) as unknown;
    const restarted = make();
    await restarted.resume();
    expect(JSON.parse(JSON.stringify(run()))).toEqual(saved);
    expect(restarted.run('w1', ISSUE)).toMatchObject({ stage: 'dev', oid: 'default' });
  });
});

describe('the ceiling of rounds and the user (research R7, US4 sc.2)', () => {
  it('reads the cap of the version of the run, and the passes, brief and merge mode', async () => {
    workflow = {
      ...defaultWorkflow(current.delivery),
      stages: defaultWorkflow(current.delivery).stages.map((s) =>
        s.type === 'polish'
          ? { ...s, passes: 2, instruction: 'Noms' }
          : s.type === 'pr'
            ? { ...s, mergeMode: 'rebase' as const }
            : s,
      ),
      transitions: defaultWorkflow(current.delivery).transitions.map((t) =>
        t.maxRounds === undefined ? t : { ...t, maxRounds: 5 },
      ),
    };
    await service.register('w1', ISSUE);
    expect(service.maxRounds('w1', ISSUE)).toBe(5);
    expect(service.polish('w1', ISSUE)).toEqual({ passes: 2, brief: 'Noms' });
    expect(service.mergeModeOf('w1', ISSUE)).toBe('rebase');
  });

  it('without a run, the settings of 008 are the answer', () => {
    current = { ...current, delivery: { ...current.delivery, maxRounds: 4, polishBrief: 'B' } };
    expect(service.maxRounds('w1', 'inconnue')).toBe(4);
    expect(service.polish('w1', 'inconnue')).toEqual({ passes: 1, brief: 'B' });
    expect(service.mergeModeOf('w1', null)).toBe('squash');
  });

  it('a capped return into dev while the loop is escalated waits for the user, no new stage', async () => {
    await runAt('pr', loopOf('escalated'));
    await service.handle(
      'w1',
      event('delivery', dev, { delivery: { id: uuid(500), outcome: 'ci-red' } }),
    );
    expect(run()).toMatchObject({ stage: 'pr', status: 'waiting-user' });
    expect(stageMessages()[0]?.draft.text).toBe(
      `Étape pr · ${ISSUE} : plafond de 3 tours atteint, l’utilisateur décide`,
    );
  });

  it('setWaiting: waiting-user at the escalation, active again at « restart »', async () => {
    await runAt('dev', loopOf('escalated'));
    await service.setWaiting('w1', ISSUE, true);
    expect(run()?.status).toBe('waiting-user');
    await service.setWaiting('w1', ISSUE, false);
    expect(run()?.status).toBe('active');
  });
});

describe('the instruction of a stage (T014, research R9)', () => {
  const withInstruction = (stageId: string, instruction: string): Workflow => {
    const flow = defaultWorkflow(current.delivery);
    return {
      ...flow,
      stages: flow.stages.map((s) => (s.id === stageId ? { ...s, instruction } : s)),
    };
  };

  it('enters a stage with an instruction: one instruction per bound agent, fixed text then the workflow’s', async () => {
    workflow = withInstruction('dev', 'Pas de dépendance nouvelle.');
    await runAt('test', loopOf('running', [storedReport(tester)]));
    current = { ...current, runs: current.runs.map((r) => ({ ...r, workflow })) };
    await service.handle('w1', event('report', tester));
    expect(instructions()).toHaveLength(1);
    const [sent] = instructions();
    expect(sent?.draft.to).toBe(dev.id);
    expect(sent?.draft.from).toBe('pact');
    expect(sent?.draft.text).toMatch(
      /^Fais passer les tests d’acceptation de l’issue 0012-connexion/,
    );
    expect(sent?.draft.text).toMatch(/\n\nConsigne du workflow : Pas de dépendance nouvelle\.$/);
  });

  it('a stage without instruction sends none of its own: the fixed one stays the loop’s (007 FR-021)', async () => {
    await runAt('test', loopOf('running', [storedReport(tester)]));
    await service.handle('w1', event('report', tester));
    expect(run()?.stage).toBe('dev');
    expect(instructions()).toHaveLength(0);
  });

  it('an agent bound after the entry gets the instruction when it is bound', async () => {
    workflow = withInstruction('test', 'Tests d’abord.');
    await service.register('w1', ISSUE);
    expect(run()?.stage).toBe('test');
    expect(instructions()).toHaveLength(0);
    await service.bind('w1', ISSUE, { test: tester.id, dev: dev.id });
    expect(run()?.bindings).toEqual({ tester: tester.id, dev: dev.id });
    expect(instructions().map((i) => i.draft.to)).toEqual([tester.id]);
    expect(instructions()[0]?.draft.text).toContain('Consigne du workflow : Tests d’abord.');
    // Bound twice to the same agents: nothing is sent again.
    await service.bind('w1', ISSUE, { test: tester.id, dev: dev.id });
    expect(instructions()).toHaveLength(1);
  });

  it('gives the instruction of the spec stage once, to the agent launched with the role spec (O2)', async () => {
    workflow = withInstruction('spec', 'Une issue par fichier.');
    expect(await service.specInstruction('w1')).toBe(
      'Consigne du workflow : Une issue par fichier.',
    );
    workflow = defaultWorkflow(current.delivery);
    expect(await service.specInstruction('w1')).toBeNull();
  });

  it('the polish stage replaces the brief of 008 with its instruction', async () => {
    workflow = withInstruction('polish', 'Noms et commentaires.');
    await service.register('w1', ISSUE);
    expect(service.polish('w1', ISSUE)).toEqual({ passes: 1, brief: 'Noms et commentaires.' });
  });
});
