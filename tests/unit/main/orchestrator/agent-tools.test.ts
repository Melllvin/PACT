import { describe, expect, it, vi } from 'vitest';
import { createAgentTools } from '../../../../src/main/orchestrator/agent-tools';
import { IpcFailure } from '../../../../src/shared/ipc';

// 004 T020 — submit_report gives the loop's refusal back to the agent (FR-020).

const report = {
  issue: '0012-connexion',
  status: 'done',
  summary: 'Fait',
  files: [],
  checks: [{ command: 'npm test', exitCode: 0 }],
  verdict: { result: 'accepted', defects: [] },
};

const submit = (onReport?: () => Promise<string | null>) => {
  const [tool] = createAgentTools(onReport ? { onReport } : {}, 'a1');
  if (!tool) throw new Error('no tool');
  return tool.call(report);
};

describe('submit_report', () => {
  it('tells the agent why its verdict is rejected', async () => {
    const onReport = vi.fn(() => Promise.resolve('Verdict rejeté : le test a modifié src/a.ts.'));
    await expect(submit(onReport)).resolves.toEqual({
      content: [{ type: 'text', text: 'Verdict rejeté : le test a modifié src/a.ts.' }],
      isError: true,
    });
  });

  it('receives the report when the loop takes it, or without a loop', async () => {
    for (const result of [await submit(() => Promise.resolve(null)), await submit()]) {
      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toEqual({ type: 'text', text: 'Rapport reçu.' });
    }
  });
});

// 007 T041 — ask_orchestrator and send_message (contracts/mcp-tools.md, FR-001, FR-003, FR-008).
//
// API fixed here for the dev (see the report, « API fixées »): the tools call the journal with
//   exchanges.ask(workspaceId, agentId, text)                       → { message, warning? }
//   exchanges.send(workspaceId, { from, to, text, type? })          → { message, warning? }
// (see exchange-rules.test.ts); a refusal is a rejection with an `IpcFailure`, and the tool gives its
// message back as an error (`isError`), the way `get_events` does. The tools hold no wait: the fake
// journal below has no `wait` and no `read` for them.

type ToolSet = ReturnType<typeof createAgentTools>;

const WS = 'w1';
const ME = '00000000-0000-4000-8000-000000000002';
const message = { id: '00000000-0000-4000-8000-0000000000aa' };

const exchangesFake = (overrides: Record<string, unknown> = {}) => {
  const ask = vi.fn(() => Promise.resolve({ message }));
  const send = vi.fn(() => Promise.resolve({ message }));
  const exchanges = {
    workspaceOf: () => WS,
    read: vi.fn(),
    detail: vi.fn(),
    ask,
    send,
    ...overrides,
  };
  const tools = createAgentTools(
    {
      exchanges: exchanges as unknown as NonNullable<
        Parameters<typeof createAgentTools>[0]['exchanges']
      >,
    },
    ME,
  );
  return { tools, ask, send };
};

const named = (tools: ToolSet, name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const textOf = (result: Awaited<ReturnType<ToolSet[number]['call']>>) =>
  result.content.map((c) => c.text).join('\n');

describe('the tools of an agent with a role (FR-001, FR-008)', () => {
  it('Given a journal, When the tools are listed, Then an agent has exactly get_events, ask_orchestrator, send_message and submit_report: none grants a permission', () => {
    const { tools } = exchangesFake();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_orchestrator',
      'get_events',
      'send_message',
      'submit_report',
    ]);
  });
});

describe('ask_orchestrator', () => {
  it('Given a question, When it is asked, Then the call returns at once with the instruction to finish the turn', async () => {
    const { tools, ask } = exchangesFake();
    const result = await named(tools, 'ask_orchestrator').call({ text: 'Quelle base ?' });
    expect(result.isError).toBeUndefined();
    expect(ask).toHaveBeenCalledWith(WS, ME, 'Quelle base ?');
    expect(textOf(result)).toMatch(
      /Question transmise à l['’]orchestrateur\. Finis ton tour : tu seras réveillé à sa réponse\./,
    );
  });

  it('Given no orchestrator, When it is asked, Then the call fails with the reason and the agent knows', async () => {
    const reason = 'Aucun orchestrateur dans ce workspace.';
    const { tools } = exchangesFake({
      ask: () => Promise.reject(new IpcFailure('INVALID_INPUT', reason)),
    });
    const result = await named(tools, 'ask_orchestrator').call({ text: 'Quelqu’un ?' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(reason);
  });

  it('Given an orchestrator in error, When it is asked, Then the answer says so', async () => {
    const warning = 'L’orchestrateur est en erreur : ta question attend sa reprise.';
    const { tools } = exchangesFake({ ask: () => Promise.resolve({ message, warning }) });
    const result = await named(tools, 'ask_orchestrator').call({ text: 'Et maintenant ?' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain(warning);
  });

  it.each([{}, { text: '' }, { text: 42 }])(
    'Given the arguments %j, When it is asked, Then it fails and nothing is sent',
    async (args) => {
      const { tools, ask } = exchangesFake();
      const result = await named(tools, 'ask_orchestrator').call(args);
      expect(result.isError).toBe(true);
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it('Given an agent that left its workspace, When it asks, Then it fails and nothing is sent', async () => {
    const { tools, ask } = exchangesFake({ workspaceOf: () => undefined });
    const result = await named(tools, 'ask_orchestrator').call({ text: 'Ok ?' });
    expect(result.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('send_message', () => {
  it('Given a recipient and a text, When it is sent, Then the call returns the id at once', async () => {
    const { tools, send } = exchangesFake();
    const to = '00000000-0000-4000-8000-000000000003';
    const result = await named(tools, 'send_message').call({ to, text: 'Le gabarit est prêt' });
    expect(result.isError).toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ from: ME, to, text: 'Le gabarit est prêt' }),
    );
    expect(textOf(result)).toContain(message.id);
  });

  it('Given a type info, When it is sent, Then the journal gets info; by default it does not get info', async () => {
    const { tools, send } = exchangesFake();
    const to = '00000000-0000-4000-8000-000000000003';
    await named(tools, 'send_message').call({ to, text: 'FYI', type: 'info' });
    await named(tools, 'send_message').call({ to, text: 'À faire' });
    const types = (send.mock.calls as unknown as [string, { type?: string }][]).map(
      ([, input]) => input.type,
    );
    expect(types[0]).toBe('info');
    expect(types[1]).not.toBe('info');
  });

  it('Given a recipient in error, When it is sent, Then the warning of the journal reaches the agent', async () => {
    const warning = 'Le destinataire est en erreur : le message l’attend.';
    const { tools } = exchangesFake({ send: () => Promise.resolve({ message, warning }) });
    const result = await named(tools, 'send_message').call({ to: ME, text: 'Salut' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain(warning);
    expect(textOf(result)).toContain(message.id);
  });

  it('Given the matrix refuses, When it is sent, Then the call fails with the reason of the matrix', async () => {
    const reason = 'Le testeur n’écrit à personne. Passe par ask_orchestrator.';
    const { tools } = exchangesFake({
      send: () => Promise.reject(new IpcFailure('INVALID_INPUT', reason)),
    });
    const result = await named(tools, 'send_message').call({ to: ME, text: 'Salut' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(reason);
  });

  it.each([
    { text: 'Sans destinataire' },
    { to: ME },
    { to: ME, text: '' },
    { to: ME, text: 'x', type: 'urgent' },
  ])('Given the arguments %j, When it is sent, Then it fails and nothing is sent', async (args) => {
    const { tools, send } = exchangesFake();
    const result = await named(tools, 'send_message').call(args);
    expect(result.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
