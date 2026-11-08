import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorTools } from '../../../../src/main/orchestrator/tools';

// 007 T026 — the edges of `send_prompt`: no journal, a worker that left its workspace.

const LEAD = '00000000-0000-4000-8000-000000000001';
const WORKER = '00000000-0000-4000-8000-000000000002';

const make = (over: Record<string, unknown>) => {
  const sendPrompt = vi.fn(() => Promise.resolve(0));
  const workspace = {
    id: 'w1',
    status: 'available',
    exchanges: { messages: [] },
    agents: [
      { id: LEAD, cliId: 'fake', position: 1 },
      { id: WORKER, cliId: 'fake', position: 2, state: 'awaiting-prompt' },
    ],
  };
  const tools = createOrchestratorTools(
    {
      workspaces: { list: () => [workspace] },
      cliName: () => 'Faux CLI',
      agents: { sendPrompt, rememberInitialPrompt: vi.fn() },
      ...over,
    } as never,
    LEAD,
  );
  const send = tools.find((t) => t.name === 'send_prompt');
  return { sendPrompt, call: (args: unknown) => send?.call(args) };
};

describe('send_prompt around the journal', () => {
  it('Given no journal, When an instruction is sent, Then it is typed as before', async () => {
    const { sendPrompt, call } = make({});
    const result = await call({ agent: WORKER, text: 'Fais ceci' });
    expect(result?.isError).toBeUndefined();
    expect(sendPrompt).toHaveBeenCalledWith(WORKER, 'Fais ceci', 'orchestrator');
  });

  it('Given an agent that is in no workspace of the journal, When an instruction is sent, Then it is refused', async () => {
    const exchanges = { workspaceOf: () => undefined, record: vi.fn() };
    const { call } = make({ exchanges });
    const result = await call({ agent: WORKER, text: 'Fais ceci' });
    expect(result?.isError).toBe(true);
    expect(exchanges.record).not.toHaveBeenCalled();
  });

  it('Given a journal of another workspace, When an instruction is sent, Then nothing waits before it', async () => {
    const exchanges = { workspaceOf: () => 'autre', record: vi.fn(() => Promise.resolve({})) };
    const { call } = make({ exchanges });
    const result = await call({ agent: WORKER, text: 'Fais ceci' });
    expect(result?.isError).toBeUndefined();
    expect(exchanges.record).toHaveBeenCalledOnce();
  });
});
