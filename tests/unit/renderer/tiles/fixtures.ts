import type { Agent, FreeTerminal } from '../../../../src/shared/model';

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
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
  ...overrides,
});

export const freeTerminal = (n: number): FreeTerminal => ({
  id: uuid(100 + n),
  workspaceId: 'w1',
  cwd: '/w',
  shell: '/bin/zsh',
});

/** An agent stopped by a rate limit (US7). */
export const rateLimited = {
  state: 'error',
  lastError: { code: null, kind: 'rate-limit', message: 'Limite de débit atteinte' },
} as const satisfies Partial<Agent>;

export const scheduledResume = {
  agentId: uuid(1),
  at: '2030-01-01T09:30:00.000Z',
  attempt: 0,
};

/** The time of `scheduledResume` as the tiles show it, in the local time zone. */
export const time = new Date(scheduledResume.at).toLocaleTimeString('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
});
