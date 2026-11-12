import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorTools } from '../../../src/main/orchestrator/tools';
import {
  ORCHESTRATOR_ACTION_TOOLS,
  orchestratorActionSchema,
} from '../../../src/shared/orchestrator';

// 008 T015 — the tools of the orchestrator around the delivery (contracts/mcp-tools.md): `request_delivery`
// with its refusals, `request_integration` gone, `close_agent` refused while a delivery runs (FR-001,
// FR-007). The tools are built as the app builds them, over fakes of what they call.
//
// RED until T020. Assumed API: `deps.delivery.request(workspaceId, { agentId, title, message,
// requestedBy: 'orchestrator' })` resolves the Delivery (`state: 'refused'` and `reason` when the
// barriers refuse it); the tool turns a refusal into an error with that reason, and otherwise
// answers `{ deliveryId, state, commit }` with `commit` = F on 7 characters.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const TESTER = uuid(3);
const OTHER = uuid(4);
const FROZEN = 'abcdef0123456789abcdef0123456789abcdef01';

const agent = (id: string, position: number, role: string | null) => ({
  id,
  cliId: 'fake',
  position,
  role,
  state: 'done',
  branch: `agent/${String(position)}`,
});

const make = (deliveries: unknown[] = [], request?: unknown) => {
  const workspace = {
    id: 'w1',
    status: 'available',
    exchanges: { messages: [], escalations: [] },
    agents: [
      agent(LEAD, 1, 'orchestrator'),
      agent(DEV, 2, 'dev'),
      agent(TESTER, 3, 'test'),
      agent(OTHER, 4, null),
    ],
    loops: [{ issueId: '0012-connexion', devAgentId: DEV, testAgentId: TESTER, state: 'accepted' }],
    deliveries,
  };
  const delivery = {
    request:
      request ??
      vi.fn(() =>
        Promise.resolve({ id: uuid(9), state: 'syncing', reason: null, frozenCommit: FROZEN }),
      ),
  };
  const close = vi.fn(() => Promise.resolve());
  const log = vi.fn();
  const tools = createOrchestratorTools(
    {
      workspaces: { list: () => [workspace] },
      cliName: () => 'Faux CLI',
      agents: { close },
      delivery,
      log,
    } as never,
    LEAD,
  );
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)?.call(args);
  return { tools, call, delivery, close, log };
};

const ARGS = { issue: '0012-connexion', title: 'Connexion par e-mail', message: 'feat: connexion' };

describe('request_delivery', () => {
  it('Given an accepted loop, When the orchestrator asks, Then the dev of the loop is requested with the title and the message, and the tool answers at once', async () => {
    const { call, delivery } = make();

    const result = await call('request_delivery', ARGS);

    expect(result?.isError).toBeUndefined();
    expect(delivery.request).toHaveBeenCalledWith('w1', {
      agentId: DEV,
      title: 'Connexion par e-mail',
      message: 'feat: connexion',
      requestedBy: 'orchestrator',
    });
    expect(JSON.parse(result?.content[1]?.text ?? '{}')).toEqual({
      deliveryId: uuid(9),
      state: 'syncing',
      commit: 'abcdef0',
    });
  });

  it('Given a refusal of the barriers, When the orchestrator asks, Then the call fails with the reason and the refusal is logged', async () => {
    const reason = 'Le verdict porte sur abcdef0, la tête est 1234567.';
    const request = vi.fn(() =>
      Promise.resolve({ id: uuid(9), state: 'refused', reason, frozenCommit: FROZEN }),
    );
    const { call, log } = make([], request);

    const result = await call('request_delivery', ARGS);

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(reason);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'request_delivery',
        outcome: 'refused',
        reason: expect.stringContaining(reason) as unknown,
      }),
    );
  });

  it('Given an accepted request, When it is logged, Then the action is one the journal of actions knows', async () => {
    const { call, log } = make();

    await call('request_delivery', ARGS);

    const [entry] = log.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({ tool: 'request_delivery', outcome: 'ok' });
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

  it('Given an issue without a loop, When the orchestrator asks, Then it is refused and nothing is requested', async () => {
    const { call, delivery } = make();

    const result = await call('request_delivery', { ...ARGS, issue: '0099-inconnue' });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('0099-inconnue');
    expect(delivery.request).not.toHaveBeenCalled();
  });

  it.each([
    ['no title', { ...ARGS, title: '' }],
    ['a title over 200 characters', { ...ARGS, title: 'x'.repeat(201) }],
    ['no message', { ...ARGS, message: '  ' }],
    ['a message over 4000 characters', { ...ARGS, message: 'x'.repeat(4001) }],
    ['no issue', { title: ARGS.title, message: ARGS.message }],
  ])(
    'Given %s, When the orchestrator asks, Then it is refused before the service is called',
    async (_name, args) => {
      const { call, delivery } = make();

      const result = await call('request_delivery', args);

      expect(result?.isError).toBe(true);
      expect(delivery.request).not.toHaveBeenCalled();
    },
  );

  it('Given the tool, When its schema is read, Then it asks for the issue, a title of 1 to 200 and a message of 1 to 4000', () => {
    const { tools } = make();

    const schema = tools.find((t) => t.name === 'request_delivery')?.inputSchema as {
      required: string[];
      properties: Record<string, { minLength?: number; maxLength?: number }>;
    };

    expect(schema.required.sort()).toEqual(['issue', 'message', 'title']);
    expect(schema.properties.title).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(schema.properties.message).toMatchObject({ minLength: 1, maxLength: 4000 });
  });
});

describe('request_integration is gone', () => {
  it('Given the tools of the orchestrator, When they are listed, Then request_integration is not one and request_delivery is', () => {
    const { tools } = make();

    const names = tools.map((t) => t.name);

    expect(names).not.toContain('request_integration');
    expect(names).toContain('request_delivery');
  });

  it('Given the actions the journal records, When they are listed, Then request_integration is not one and request_delivery is', () => {
    expect(ORCHESTRATOR_ACTION_TOOLS).not.toContain('request_integration');
    expect(ORCHESTRATOR_ACTION_TOOLS).toContain('request_delivery');
  });
});

describe('close_agent during a delivery (FR-007)', () => {
  const running = { agentId: DEV, testAgentId: TESTER, state: 'watching' };

  it.each([
    ['the dev', DEV],
    ['the tester', TESTER],
  ])(
    'Given a delivery that is not final, When the orchestrator closes %s, Then it is refused and nothing is closed',
    async (_who, id) => {
      const { call, close } = make([running]);

      const result = await call('close_agent', { agent: id });

      expect(result?.isError).toBe(true);
      expect(result?.content[0]?.text).toMatch(/livraison/i);
      expect(close).not.toHaveBeenCalled();
    },
  );

  it.each(['merged', 'dropped', 'refused', 'user-refused', 'tests-failed', 'conflicted'])(
    'Given a delivery that is final (%s), When the orchestrator closes the dev, Then it is closed, the worktree kept',
    async (state) => {
      const { call, close } = make([{ ...running, state }]);

      const result = await call('close_agent', { agent: DEV });

      expect(result?.isError).toBeUndefined();
      expect(close).toHaveBeenCalledWith(DEV, { removeWorktree: false });
    },
  );

  it('Given a delivery of the dev, When the orchestrator closes another agent, Then it is closed', async () => {
    const { call, close } = make([running]);

    const result = await call('close_agent', { agent: OTHER });

    expect(result?.isError).toBeUndefined();
    expect(close).toHaveBeenCalledWith(OTHER, { removeWorktree: false });
  });
});
