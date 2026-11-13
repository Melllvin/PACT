import { describe, expect, it, vi } from 'vitest';
import { WorkflowService } from '../../../../src/main/workflow/workflow-service';
import { defaultDeliverySettings } from '../../../../src/shared/delivery';
import { DEFAULT_TEST_PATHS, type Agent, type Workspace } from '../../../../src/shared/model';
import { defaultWorkflow, type Workflow } from '../../../../src/shared/workflow';

// 010 US1 — the edges of the engine: a file with a second-phase feature refuses the run, the settings of
// 008 reach the runs on the default workflow, a message without a loop or a run does nothing.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ISSUE = '0012-connexion';
const lead = { id: uuid(1), role: 'orchestrator' } as Agent;

const base = (over: Partial<Workspace> = {}): Workspace =>
  ({
    id: 'w1',
    path: '/w',
    mainBranch: 'main',
    agents: [lead],
    delivery: defaultDeliverySettings(),
    deliveries: [],
    loops: [],
    issues: [
      {
        id: ISSUE,
        title: 'Connexion',
        path: `.pact/issues/${ISSUE}.md`,
        state: 'proposed',
        remote: null,
        trace: { branch: null, agents: [], pr: null },
      },
    ],
    exchanges: { messages: [], escalations: [] },
    testPaths: [...DEFAULT_TEST_PATHS],
    runs: [],
    ...over,
  }) as unknown as Workspace;

function setup(
  options: { workspace?: Partial<Workspace>; workflow?: Workflow; phase2?: string[] } = {},
) {
  let current = base(options.workspace);
  const workflow = options.workflow ?? defaultWorkflow(current.delivery);
  const record = vi.fn(() => Promise.resolve({} as never));
  const onChange = vi.fn();
  const service = new WorkflowService({
    workspaces: {
      get: () => current,
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
          phase2: (options.phase2 ?? []).map((message) => ({ code: 'phase2' as const, message })),
        }),
    },
    exchanges: { record },
    onChange,
    now: () => new Date('2026-11-13T10:00:00.000Z'),
  });
  return { service, record, onChange, state: () => current };
}

describe('a run that cannot start', () => {
  it('Given a file with a second-phase feature, When the issue is registered, Then the run is refused with the reason, no stage message', async () => {
    const s = setup({ phase2: ['when : condition non exécutée'] });

    const run = await s.service.register('w1', ISSUE);

    expect(run).toMatchObject({ status: 'refused', stage: 'spec' });
    expect(run.reason).toContain('when : condition non exécutée');
    expect(s.record).not.toHaveBeenCalled();
    expect(s.onChange).toHaveBeenCalled();
  });
});

describe('the settings of 008 and the runs on the default workflow (FR-020)', () => {
  it('Given a ceiling changed in the settings, When the settings change, Then the run on the default workflow takes it', async () => {
    const s = setup();
    await s.service.register('w1', ISSUE);
    expect(s.service.maxRounds('w1', ISSUE)).toBe(3);

    const changed = base({ delivery: { ...defaultDeliverySettings(), maxRounds: 5 } });
    const again = setup({ workspace: changed });
    await again.service.register('w1', ISSUE);
    expect(again.service.maxRounds('w1', ISSUE)).toBe(5);
  });

  it('Given a run created with the old ceiling, When the settings are saved, Then the run reads the new one; a finished run keeps its own', async () => {
    const s = setup();
    await s.service.register('w1', ISSUE);
    await s.service.settingsChanged('w1');
    expect(s.service.maxRounds('w1', ISSUE)).toBe(3);

    const live = s.state();
    live.delivery.maxRounds = 6;
    await s.service.settingsChanged('w1');
    expect(s.service.maxRounds('w1', ISSUE)).toBe(6);

    const later = s.state();
    later.runs[0] = { ...later.runs[0], status: 'finished' } as never;
    later.delivery.maxRounds = 2;
    await s.service.settingsChanged('w1');
    expect(s.service.maxRounds('w1', ISSUE)).toBe(6);
  });
});

describe('what the engine leaves alone', () => {
  it('Given a message of an agent that is in no loop, Then nothing happens', async () => {
    const s = setup();
    await s.service.handle('w1', {
      id: uuid(9),
      at: '2026-11-13T10:00:00.000Z',
      from: uuid(7),
      to: lead.id,
      type: 'action',
      kind: 'report',
      text: 'x',
      unreadBy: [],
    });
    expect(s.state().runs).toEqual([]);
    expect(s.record).not.toHaveBeenCalled();
  });

  it('Given a message of a kind that gives no outcome, Then it is not even read', async () => {
    const s = setup();
    await s.service.handle('w1', {
      id: uuid(9),
      at: '2026-11-13T10:00:00.000Z',
      from: 'pact',
      to: lead.id,
      type: 'action',
      kind: 'publish',
      text: 'x',
      unreadBy: [],
    });
    expect(s.state().runs).toEqual([]);
  });

  it('Given no run, setWaiting and bind of an unknown run change nothing, and the file is read once for the spec instruction', async () => {
    const s = setup();
    await s.service.setWaiting('w1', 'inconnue', true);
    expect(s.state().runs).toEqual([]);
    expect(await s.service.specInstruction('w1')).toBeNull();
  });

  it('Given an issue still proposed with a run on spec, When register is called again, Then it stays on spec', async () => {
    const s = setup();
    await s.service.register('w1', ISSUE);
    const again = await s.service.register('w1', ISSUE);
    expect(again.stage).toBe('spec');
    expect(s.state().runs).toHaveLength(1);
  });
});
