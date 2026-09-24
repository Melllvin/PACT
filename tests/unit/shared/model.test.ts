import { describe, expect, it } from 'vitest';
import {
  AGENT_COLORS,
  agentSchema,
  agentStateSchema,
  cliDefinitionSchema,
  freeTerminalSchema,
  permissionPreferenceSchema,
  recentProjectsSchema,
  scheduledResumeSchema,
  workspaceSchema,
  type Agent,
  type Workspace,
} from '../../../src/shared/model';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-24T10:00:00.000Z';

const agent = (position: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(position),
  workspaceId: 'w1',
  position,
  color: AGENT_COLORS[position - 1] ?? 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(position)}`,
  worktreePath: `/repo/.worktrees/claude-code-${String(position)}`,
  port: 3000 + position,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'starting',
  lastError: null,
  scheduledResume: null,
  ...overrides,
});

const workspace = (agents: Agent[]): Workspace => ({
  id: 'w1',
  path: '/repo',
  name: 'repo',
  mainBranch: 'main',
  agents,
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: now,
  status: 'available',
});

describe('Agent', () => {
  it('accepts a valid agent', () => {
    expect(agentSchema.safeParse(agent(1)).success).toBe(true);
  });

  it.each([0, 7, 1.5])('rejects position %s (1..6)', (position) => {
    expect(agentSchema.safeParse(agent(1, { position })).success).toBe(false);
  });

  it('orders colors purple, cyan, green, magenta, yellow, slate', () => {
    expect(AGENT_COLORS).toEqual(['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate']);
  });

  it('rejects a color outside the palette (orange and red are reserved)', () => {
    expect(agentSchema.safeParse({ ...agent(1), color: 'orange' }).success).toBe(false);
  });

  it('accepts exactly the three permission levels', () => {
    for (const permissionLevel of ['always-allow', 'ask-sensitive', 'always-ask'] as const) {
      expect(agentSchema.safeParse(agent(1, { permissionLevel })).success).toBe(true);
    }
    expect(agentSchema.safeParse({ ...agent(1), permissionLevel: 'bypass' }).success).toBe(false);
  });

  it('knows every agent state of the data model', () => {
    expect(agentStateSchema.options).toEqual([
      'starting',
      'awaiting-prompt',
      'working',
      'awaiting-answer',
      'done',
      'error',
      'closed',
    ]);
  });

  it('describes the last error and the scheduled resume', () => {
    const parsed = agentSchema.safeParse(
      agent(1, {
        state: 'error',
        lastError: { code: null, kind: 'rate-limit', message: 'Rate limited' },
        scheduledResume: { agentId: uuid(1), at: now, attempt: 0 },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-range port', () => {
    expect(agentSchema.safeParse(agent(1, { port: 70000 })).success).toBe(false);
  });
});

describe('Workspace', () => {
  it('holds 0 to 6 agents', () => {
    expect(workspaceSchema.safeParse(workspace([])).success).toBe(true);
    const six = [1, 2, 3, 4, 5, 6].map((p) => agent(p));
    expect(workspaceSchema.safeParse(workspace(six)).success).toBe(true);
    const seven = [...six, agent(6, { id: uuid(7), port: 3010, branch: 'x' })];
    expect(workspaceSchema.safeParse(workspace(seven)).success).toBe(false);
  });

  it.each([
    ['position', { position: 1, port: 3009, branch: 'other' }],
    ['port', { port: 3001, branch: 'other' }],
    ['branch', { branch: 'agent/claude-code-1', port: 3009 }],
  ] as const)('rejects two agents sharing a %s', (_field, clash) => {
    const second = agent(2, { ...clash });
    expect(workspaceSchema.safeParse(workspace([agent(1), second])).success).toBe(false);
  });

  it('remembers quick-launch counters per CLI and for free terminals', () => {
    const parsed = workspaceSchema.parse({
      ...workspace([]),
      quickLaunchCounters: { freeTerminal: 1, 'claude-code': 2 },
    });
    expect(parsed.quickLaunchCounters).toEqual({ freeTerminal: 1, 'claude-code': 2 });
  });

  it('rejects negative counters', () => {
    const invalid = { ...workspace([]), quickLaunchCounters: { freeTerminal: -1 } };
    expect(workspaceSchema.safeParse(invalid).success).toBe(false);
  });

  it('is available or unavailable', () => {
    expect(workspaceSchema.safeParse({ ...workspace([]), status: 'gone' }).success).toBe(false);
  });
});

describe('RecentProject list', () => {
  const recent = (n: number) => ({
    path: `/p${String(n)}`,
    name: `p${String(n)}`,
    branch: 'main',
    keptWorktrees: 0,
    lastOpenedAt: now,
  });

  it('keeps at most 20 entries', () => {
    expect(
      recentProjectsSchema.safeParse(Array.from({ length: 20 }, (_, i) => recent(i))).success,
    ).toBe(true);
    expect(
      recentProjectsSchema.safeParse(Array.from({ length: 21 }, (_, i) => recent(i))).success,
    ).toBe(false);
  });
});

describe('CliDefinition', () => {
  const cli = {
    id: 'claude-code',
    name: 'Claude Code',
    adapter: 'claude-code',
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    version: '2.1.281',
    origin: 'detected',
    status: 'installed',
    models: [],
  };

  it('accepts installed, missing and unsupported-version', () => {
    for (const status of ['installed', 'missing', 'unsupported-version']) {
      expect(cliDefinitionSchema.safeParse({ ...cli, status }).success).toBe(true);
    }
    expect(cliDefinitionSchema.safeParse({ ...cli, status: 'logged-out' }).success).toBe(false);
  });

  it('accepts custom CLIs identified as custom-<slug>', () => {
    const custom = { ...cli, id: 'custom-aider', adapter: 'generic', origin: 'custom' };
    expect(cliDefinitionSchema.safeParse(custom).success).toBe(true);
    expect(cliDefinitionSchema.safeParse({ ...custom, id: 'aider' }).success).toBe(false);
  });
});

describe('PermissionPreference', () => {
  it('defaults to always-allow with auto resume enabled', () => {
    expect(permissionPreferenceSchema.parse({ scope: 'global' })).toEqual({
      level: 'always-allow',
      autoResume: true,
      scope: 'global',
    });
  });

  it('has a project or global scope', () => {
    expect(permissionPreferenceSchema.safeParse({ scope: 'machine' }).success).toBe(false);
  });
});

describe('ScheduledResume and FreeTerminal', () => {
  it('requires an ISO date and a non-negative attempt', () => {
    expect(
      scheduledResumeSchema.safeParse({ agentId: uuid(1), at: 'soon', attempt: 0 }).success,
    ).toBe(false);
    expect(
      scheduledResumeSchema.safeParse({ agentId: uuid(1), at: now, attempt: -1 }).success,
    ).toBe(false);
  });

  it('describes a free terminal', () => {
    const terminal = { id: uuid(9), workspaceId: 'w1', cwd: '/repo', shell: '/bin/zsh' };
    expect(freeTerminalSchema.safeParse(terminal).success).toBe(true);
  });
});
