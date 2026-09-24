import { describe, expect, it } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent, FreeTerminal, Workspace } from '../../../src/shared/model';

// T080 — the À faire items, derived from the agents only (data-model TodoItem, FR-027, FR-028).

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: `a${String(n)}`,
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
  state: 'working',
  lastError: null,
  scheduledResume: null,
  ...overrides,
});

const shell = (id: string, path: string): FreeTerminal => ({
  id,
  workspaceId: 'w1',
  cwd: '/w',
  shell: path,
});

const workspace = (agents: Agent[], freeTerminals: FreeTerminal[] = []) =>
  ({ agents, freeTerminals, mainBranch: 'main' }) satisfies Pick<
    Workspace,
    'agents' | 'freeTerminals' | 'mainBranch'
  >;

const names = (id: string) => ({ 'claude-code': 'Claude Code', codex: 'Codex' })[id] ?? id;

const rateLimited = { code: 1, kind: 'rate-limit' as const, message: 'Limite atteinte' };

describe('deriveTodos', () => {
  it('asks to answer first, then rate limits, then prompts, then free terminals', () => {
    const todos = deriveTodos(
      workspace(
        [
          agent(1, { state: 'awaiting-prompt' }),
          agent(2, { state: 'error', lastError: rateLimited }),
          agent(3, { state: 'awaiting-answer' }),
          agent(4, { state: 'awaiting-answer' }),
        ],
        [shell('t1', '/bin/zsh')],
      ),
      names,
    );
    expect(todos.map((t) => t.id)).toEqual([
      'a3:answer',
      'a4:answer',
      'a2:rate-limit',
      'a1:prompt',
      't1:info',
    ]);
  });

  it('keeps the tile order within a kind, whatever the order of the agents', () => {
    const todos = deriveTodos(
      workspace([agent(2, { state: 'awaiting-answer' }), agent(1, { state: 'awaiting-answer' })]),
      names,
    );
    expect(todos.map((t) => t.agentId)).toEqual(['a1', 'a2']);
  });

  it('offers the same actions as the tile (FR-028)', () => {
    const [answer, limit] = deriveTodos(
      workspace([
        agent(1, { state: 'awaiting-answer' }),
        agent(2, { state: 'error', lastError: rateLimited }),
      ]),
      names,
    );
    expect(answer).toMatchObject({
      kind: 'answer',
      title: '◆ Répondre',
      actions: ['allow', 'deny'],
    });
    expect(limit).toMatchObject({
      kind: 'rate-limit',
      title: '✕ Limite de débit · Claude Code',
      actions: ['log', 'restart', 'resume'],
    });
  });

  it('asks for a prompt for each agent waiting for one, naming its CLI', () => {
    const [todo] = deriveTodos(
      workspace([agent(1, { state: 'awaiting-prompt', cliId: 'codex' })]),
      names,
    );
    expect(todo).toEqual({
      id: 'a1:prompt',
      agentId: 'a1',
      kind: 'prompt',
      title: 'Donner une consigne · Codex · tapez dans le terminal',
      actions: [],
    });
  });

  it('shows each free terminal as running on the main branch', () => {
    const todos = deriveTodos(
      workspace(
        [],
        [shell('t1', '/bin/zsh'), shell('t2', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')],
      ),
      names,
    );
    expect(todos.map((t) => t.title)).toEqual(['En cours ▸ zsh — main', 'En cours ▸ pwsh — main']);
    expect(todos[0]).toMatchObject({ kind: 'info', agentId: 't1', actions: [] });
  });

  it('lists nothing for agents that are starting, working, done, closed or crashed', () => {
    const states = ['starting', 'working', 'done', 'closed'] as const;
    const agents = states.map((state, i) => agent(i + 1, { state }));
    agents.push(
      agent(9, {
        state: 'error',
        lastError: { code: 1, kind: 'crash', message: 'Le processus s’est arrêté (code 1).' },
      }),
    );
    expect(deriveTodos(workspace(agents), names)).toEqual([]);
  });
});
