import { describe, expect, it } from 'vitest';
import { createAgentTools } from '../../../../src/main/orchestrator/agent-tools';

// 007 US3 — a failure of the journal that is not a refusal is not hidden as one: it surfaces.

const ME = '00000000-0000-4000-8000-000000000002';

describe('ask_orchestrator', () => {
  it('Given a journal that breaks with an unexpected error, When the question is asked, Then the error surfaces instead of being told as a refusal', async () => {
    const tools = createAgentTools(
      {
        exchanges: {
          workspaceOf: () => 'w1',
          read: () => Promise.reject(new Error('unused')),
          detail: () => Promise.reject(new Error('unused')),
          ask: () => Promise.reject(new Error('disque plein')),
          send: () => Promise.reject(new Error('unused')),
        },
      },
      ME,
    );
    const tool = tools.find((t) => t.name === 'ask_orchestrator');
    await expect(tool?.call({ text: 'Une question' })).rejects.toThrow('disque plein');
  });
});

describe('a journal that cannot write, and arguments that are not an object', () => {
  const readOnly = createAgentTools(
    {
      exchanges: {
        workspaceOf: () => 'w1',
        read: () => Promise.reject(new Error('unused')),
        detail: () => Promise.reject(new Error('unused')),
      },
    },
    ME,
  );
  const named = (name: string) => {
    const tool = readOnly.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };

  it.each([
    ['ask_orchestrator', { text: 'Une question' }, /questions ne sont pas disponibles/],
    ['send_message', { to: 'Claude Code 3', text: 'Salut' }, /messages ne sont pas disponibles/],
  ] as const)(
    'Given a journal without write, When %s is called, Then the agent is told it is not available',
    async (name, args, reason) => {
      const result = await named(name).call(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(reason);
    },
  );

  it.each([null, 'texte', 42])(
    'Given %j as the arguments, When a question is asked, Then the missing text is refused',
    async (args) => {
      const result = await named('ask_orchestrator').call(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/text/);
    },
  );
});
