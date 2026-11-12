import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorTools } from '../../../src/main/orchestrator/tools';
import {
  ORCHESTRATOR_ACTION_TOOLS,
  orchestratorActionSchema,
} from '../../../src/shared/orchestrator';

// 008 T055 — the tools of the loop under the project's ceiling (contracts/mcp-tools.md « Outils modifiés » and
// `polish_pass`; US5 sc.7, FR-021): the descriptions of `start_loop` and `next_round` no longer say « 3 tours »,
// the replies show the ceiling of the project, `polish_pass` exists. The tools are built as the app builds them,
// over fakes of what they call (same style as tools-delivery.test.ts).
//
// RED until T059. Assumed API:
//   - the description of `start_loop` is « … au plus le plafond du projet (N tours) … » with N =
//     `workspace.delivery.maxRounds` at the time the tools are built; `next_round`’s names the plafond du
//     projet too and never « 3 tours » (but may name N);
//   - the replies of `start_loop`, `next_round` and `get_loop` show `tour k/N` with N = `maxRounds`;
//   - `polish_pass({ issue, notes? })` calls `deps.loops.polish(workspaceId, issue, notes?)`, which resolves
//     `{ pass, total, sent }`; the tool answers with that JSON as the second content, a sentence naming who got the
//     instruction, and a refusal of the loop becomes an error with its reason;
//   - `ORCHESTRATOR_ACTION_TOOLS` lists `polish_pass` (the journal of actions knows it).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const TESTER = uuid(3);
const ISSUE = '0012-connexion';

const agent = (id: string, position: number, role: string | null) => ({
  id,
  cliId: 'fake',
  position,
  role,
  state: 'done',
  branch: `agent/${String(position)}`,
});

const make = (maxRounds = 5, overrides: Record<string, unknown> = {}) => {
  const workspace = {
    id: 'w1',
    status: 'available',
    exchanges: { messages: [], escalations: [] },
    agents: [agent(LEAD, 1, 'orchestrator'), agent(DEV, 2, 'dev'), agent(TESTER, 3, 'test')],
    delivery: { auto: false, mergeMode: 'squash', maxRounds, polishPasses: 2, polishBrief: '' },
    loops: [],
    deliveries: [],
  };
  const loop = (round: number) => ({
    issueId: ISSUE,
    devAgentId: DEV,
    testAgentId: TESTER,
    round,
    rounds: [],
    state: 'running',
    polish: null,
    escalatedModel: null,
  });
  const loops = {
    start: vi.fn(() =>
      Promise.resolve({ ...loop(1), sent: [{ agentId: TESTER, kind: 'instruction' }] }),
    ),
    next: vi.fn(() => Promise.resolve(loop(4))),
    get: vi.fn(() => loop(2)),
    polish: vi.fn((_workspaceId: string, _issue: string, _notes?: string) =>
      Promise.resolve({ pass: 1, total: 2, sent: [{ agentId: DEV, kind: 'instruction' }] }),
    ),
    ...overrides,
  };
  const log = vi.fn();
  const tools = createOrchestratorTools(
    {
      workspaces: { list: () => [workspace] },
      cliName: () => 'Faux CLI',
      agents: { close: vi.fn() },
      delivery: { request: vi.fn() },
      loops,
      log,
    } as never,
    LEAD,
  );
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)?.call(args);
  const description = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
  return { tools, call, description, loops, log };
};

const json = (result: { content: { text: string }[] } | undefined) =>
  JSON.parse(result?.content[1]?.text ?? '{}') as Record<string, unknown>;

describe('the descriptions no longer say « 3 tours » (US5 sc.7)', () => {
  it('Given a project with a ceiling of 5, When start_loop is described, Then it names the ceiling of the project and its value, never « 3 tours »', () => {
    const { description } = make(5);

    expect(description('start_loop')).toContain('plafond du projet');
    expect(description('start_loop')).toContain('5 tours');
    expect(description('start_loop')).not.toContain('3 tours');
  });

  it('Given a project with a ceiling of 5, When next_round is described, Then it refers to the ceiling of the project, never « 3 tours »', () => {
    const { description } = make(5);

    expect(description('next_round')).toContain('plafond du projet');
    expect(description('next_round')).not.toContain('3 tours');
  });

  it('Given the default ceiling of 3, When start_loop is described, Then the value comes from the project (« 3 tours » only because the project says 3)', () => {
    const { description } = make(3);

    expect(description('start_loop')).toContain('plafond du projet (3 tours)');
  });
});

describe('the replies show the ceiling of the project', () => {
  it('Given a ceiling of 5, When start_loop answers, Then the sentence says « tour 1/5 »', async () => {
    const { call } = make(5);

    const result = await call('start_loop', { issue: ISSUE, dev: DEV, test: TESTER });

    expect(result?.isError).toBeUndefined();
    expect(result?.content[0]?.text).toContain('tour 1/5');
    expect(result?.content[0]?.text).not.toContain('/3');
  });

  it('Given a ceiling of 5, When next_round answers, Then the sentence says « tour 4/5 »', async () => {
    const { call } = make(5);

    const result = await call('next_round', { issue: ISSUE });

    expect(result?.content[0]?.text).toContain(`${ISSUE} : tour 4/5.`);
  });

  it('Given a ceiling of 5, When get_loop answers, Then the sentence says « tour 2/5 »', async () => {
    const { call } = make(5);

    const result = await call('get_loop', { issue: ISSUE });

    expect(result?.content[0]?.text).toContain('tour 2/5');
  });

  it('Given the ceiling reached, When next_round is called, Then the refusal of the loop reaches the orchestrator with the value of the ceiling', async () => {
    const refusal = 'Plafond de 5 tours atteint : l’utilisateur décide';
    const { call, log } = make(5, { next: vi.fn(() => Promise.reject(new Error(refusal))) });

    const result = await call('next_round', { issue: ISSUE });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(refusal);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'next_round', outcome: 'refused' }),
    );
  });
});

describe('polish_pass (contracts/mcp-tools.md)', () => {
  it('Given the tools of the orchestrator, When they are listed, Then polish_pass is one, and the journal of actions knows it', () => {
    const { tools } = make();

    expect(tools.map((t) => t.name)).toContain('polish_pass');
    expect(ORCHESTRATOR_ACTION_TOOLS).toContain('polish_pass');
  });

  it('Given a polishing loop, When the orchestrator calls polish_pass with notes, Then the loop starts the pass with the issue and the notes and the tool answers { pass, total, sent }', async () => {
    const { call, loops } = make();

    const result = await call('polish_pass', { issue: ISSUE, notes: 'Les commentaires aussi' });

    expect(result?.isError).toBeUndefined();
    expect(loops.polish).toHaveBeenCalledWith('w1', ISSUE, 'Les commentaires aussi');
    expect(json(result)).toEqual({
      pass: 1,
      total: 2,
      sent: [{ agentId: DEV, kind: 'instruction' }],
    });
    expect(result?.content[0]?.text).toContain('Faux CLI 2');
    expect(result?.content[0]?.text).toContain('1');
  });

  it('Given no notes, When the orchestrator calls polish_pass, Then the loop gets none', async () => {
    const { call, loops } = make();

    await call('polish_pass', { issue: ISSUE });

    const [workspaceId, issue, notes] = loops.polish.mock.calls[0] ?? [];
    expect([workspaceId, issue]).toEqual(['w1', ISSUE]);
    expect(notes ?? null).toBeNull();
  });

  it('Given a successful call, When it is logged, Then the action is one the journal of actions knows', async () => {
    const { call, log } = make();

    await call('polish_pass', { issue: ISSUE });

    const [entry] = log.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({ tool: 'polish_pass', outcome: 'ok' });
    expect(
      orchestratorActionSchema.safeParse({
        id: uuid(7),
        at: new Date().toISOString(),
        agentId: null,
        reason: null,
        ...entry,
      }).success,
    ).toBe(true);
  });

  it('Given a loop that refuses (not polishing, or a pass already running), When the orchestrator calls polish_pass, Then the call fails with the reason and the refusal is logged', async () => {
    const reason = 'Une passe de peaufinage tourne déjà pour 0012-connexion.';
    const { call, log } = make(5, { polish: vi.fn(() => Promise.reject(new Error(reason))) });

    const result = await call('polish_pass', { issue: ISSUE });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(reason);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'polish_pass',
        outcome: 'refused',
        reason: expect.stringContaining(reason) as unknown,
      }),
    );
  });

  it.each([
    ['no issue', { notes: 'x' }],
    ['an empty issue', { issue: '' }],
    ['notes over 2000 characters', { issue: ISSUE, notes: 'x'.repeat(2001) }],
    ['notes that are not text', { issue: ISSUE, notes: 12 }],
  ])(
    'Given %s, When the orchestrator calls polish_pass, Then it is refused before the loop is called',
    async (_name, args) => {
      const { call, loops } = make();

      const result = await call('polish_pass', args);

      expect(result?.isError).toBe(true);
      expect(loops.polish).not.toHaveBeenCalled();
    },
  );

  it('Given the tool, When its schema is read, Then it asks for the issue and takes notes of 2000 characters at most', () => {
    const { tools } = make();

    const schema = tools.find((t) => t.name === 'polish_pass')?.inputSchema as {
      required: string[];
      properties: Record<string, { type?: string; maxLength?: number }>;
    };

    expect(schema.required).toEqual(['issue']);
    expect(schema.properties.notes).toMatchObject({ type: 'string', maxLength: 2000 });
  });
});
