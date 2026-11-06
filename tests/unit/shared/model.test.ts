import { describe, expect, it } from 'vitest';
import {
  AGENT_COLORS,
  agentSchema,
  agentStateSchema,
  cliDefinitionSchema,
  freeTerminalSchema,
  issueSchema,
  loopSchema,
  permissionPreferenceSchema,
  publishRequestSchema,
  recentProjectsSchema,
  reviewCommentSchema,
  roleProfileSchema,
  scheduledResumeSchema,
  workspaceSchema,
  type Agent,
  type Workspace,
} from '../../../src/shared/model';
import { agentDraftSchema, draftRole } from '../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS } from '../../../src/shared/model';

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
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
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
  testCommand: null,
  integrationRequests: [],
  roleProfiles: {},
  issues: [],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
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

// 002 — review state per agent and test command per workspace (data-model, research R9).
describe('Agent.review (002)', () => {
  const comment = {
    id: uuid(9),
    path: 'src/a.ts',
    line: 3,
    text: 'Renommer en total',
    createdAt: now,
  };

  it('defaults to nothing seen and no comment, so a workspace file from 001 still loads', () => {
    const from001: Partial<Agent> = agent(1);
    delete from001.review;
    const parsed = workspaceSchema.parse({ ...workspace([]), agents: [from001] });
    expect(parsed.agents[0]?.review).toEqual({ seen: {}, comments: [] });
  });

  it('remembers the blob seen per path and the comments in order', () => {
    const review = { seen: { 'src/a.ts': 'a'.repeat(40) }, comments: [comment] };
    expect(agentSchema.parse({ ...agent(1), review }).review).toEqual({
      ...review,
      comments: [{ ...comment, treated: false }],
    });
  });

  it.each([
    ['an empty text', { text: '' }],
    ['a text over 4000 characters', { text: 'x'.repeat(4001) }],
    ['line 0', { line: 0 }],
    ['a fractional line', { line: 1.5 }],
  ])('rejects a comment with %s', (_, change) => {
    expect(reviewCommentSchema.safeParse({ ...comment, ...change }).success).toBe(false);
  });

  it('accepts a 4000-character comment, treated or not', () => {
    expect(
      reviewCommentSchema.safeParse({ ...comment, text: 'x'.repeat(4000), treated: true }).success,
    ).toBe(true);
  });
});

describe('Workspace.testCommand (002)', () => {
  it('is null by default: the command is detected from the repository', () => {
    const from001: Partial<Workspace> = workspace([]);
    delete from001.testCommand;
    expect(workspaceSchema.parse(from001).testCommand).toBeNull();
  });

  it('accepts a command and refuses an empty string', () => {
    expect(workspaceSchema.parse({ ...workspace([]), testCommand: 'npm test' }).testCommand).toBe(
      'npm test',
    );
    expect(workspaceSchema.safeParse({ ...workspace([]), testCommand: '' }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...workspace([]), testCommand: '  ' }).success).toBe(false);
  });
});

describe('orchestrator (003 T002)', () => {
  const workspace = (agents: Agent[]): unknown => ({
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

  it('gives agents no role and workspaces no request by default, so files from 002 load', () => {
    const from002: Partial<Agent> = agent(1);
    delete from002.role;
    expect(agentSchema.parse(from002).role).toBeNull();
    expect(workspaceSchema.parse(workspace([agent(1)])).integrationRequests).toEqual([]);
  });

  it('allows one orchestrator per workspace', () => {
    expect(
      workspaceSchema.safeParse(workspace([agent(1, { role: 'orchestrator' }), agent(2)])).success,
    ).toBe(true);
    expect(
      workspaceSchema.safeParse(
        workspace([agent(1, { role: 'orchestrator' }), agent(2, { role: 'orchestrator' })]),
      ).success,
    ).toBe(false);
  });
});

describe('delivery chain (004 T004)', () => {
  const from003 = (agents: unknown[] = []): unknown => ({
    id: 'w1',
    path: '/repo',
    name: 'repo',
    mainBranch: 'main',
    agents,
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    testCommand: null,
    integrationRequests: [],
    roleProfiles: {},
    issues: [],
    loops: [],
    testPaths: [...DEFAULT_TEST_PATHS],
    publishRequests: [],
    lastOpenedAt: now,
    status: 'available',
  });

  it('reads a workspace file of 003 without a migration', () => {
    const old: Partial<Agent> = agent(1, { role: 'orchestrator' });
    delete old.effort;
    const ws = workspaceSchema.parse(from003([old]));
    expect(ws).toMatchObject({
      roleProfiles: {},
      issues: [],
      loops: [],
      publishRequests: [],
      testPaths: ['**/*.test.*', '**/*.spec.*', 'tests/**', 'test/**', '**/__tests__/**'],
    });
    expect(ws.agents[0]).toMatchObject({ role: 'orchestrator', effort: null });
  });

  it.each(['orchestrator', 'spec', 'design', 'dev', 'test', 'recap', null])(
    'accepts the role %s',
    (role) => {
      expect(agentSchema.parse({ ...agent(1), role }).role).toBe(role);
    },
  );

  it('refuses another role or effort', () => {
    expect(agentSchema.safeParse({ ...agent(1), role: 'chef' }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent(1), effort: 'énorme' }).success).toBe(false);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', null]) {
      expect(agentSchema.parse({ ...agent(1), effort }).effort).toBe(effort);
    }
  });

  it('describes a role profile, escalation off by default', () => {
    expect(
      roleProfileSchema.parse({ cliId: 'claude-code', model: null, effort: null, maxModel: null }),
    ).toEqual({
      cliId: 'claude-code',
      model: null,
      effort: null,
      maxModel: null,
      escalate: false,
    });
    const ws = workspaceSchema.parse({
      ...(from003() as object),
      roleProfiles: { dev: { cliId: 'codex', model: 'gpt-5.5', effort: 'medium', maxModel: null } },
    });
    expect(ws.roleProfiles.dev?.escalate).toBe(false);
    expect(
      workspaceSchema.safeParse({
        ...(from003() as object),
        roleProfiles: { chef: { cliId: 'codex', model: null, effort: null, maxModel: null } },
      }).success,
    ).toBe(false);
  });

  it('describes an issue, with no remote and an empty trace by default', () => {
    const issue = issueSchema.parse({
      id: '0012-connexion',
      title: 'Connexion',
      path: '.pact/issues/0012-connexion.md',
      state: 'proposed',
    });
    expect(issue).toMatchObject({ remote: null, trace: { branch: null, agents: [], pr: null } });
    for (const state of ['proposed', 'ready', 'in-progress', 'done', 'escalated', 'abandoned']) {
      expect(issueSchema.safeParse({ ...issue, state }).success).toBe(true);
    }
    expect(issueSchema.safeParse({ ...issue, state: 'fini' }).success).toBe(false);
    expect(issueSchema.safeParse({ ...issue, path: '../hors.md' }).success).toBe(false);
  });

  it('keeps a loop to 3 rounds, with two different agents', () => {
    const loop = {
      issueId: '0012-connexion',
      devAgentId: uuid(1),
      testAgentId: uuid(2),
      round: 1,
      rounds: [{ n: 1, startedAt: now }],
      state: 'running',
    };
    const parsed = loopSchema.parse(loop);
    expect(parsed.escalatedModel).toBeNull();
    expect(parsed.rounds[0]).toEqual({
      n: 1,
      startedAt: now,
      reports: [],
      proof: null,
      testerTouched: [],
    });
    expect(loopSchema.safeParse({ ...loop, round: 4 }).success).toBe(false);
    expect(loopSchema.safeParse({ ...loop, round: 0 }).success).toBe(false);
    expect(loopSchema.safeParse({ ...loop, testAgentId: uuid(1) }).success).toBe(false);
    expect(
      loopSchema.safeParse({
        ...loop,
        rounds: [{ n: 1, startedAt: now, proof: { tree: 'a'.repeat(40), exitCode: 0, at: now } }],
      }).success,
    ).toBe(true);
  });

  it('asks to publish 1 to 20 issues, one request per workspace', () => {
    const request = (issueIds: string[]) => ({ id: uuid(9), issueIds, requestedAt: now });
    expect(publishRequestSchema.safeParse(request(['0012'])).success).toBe(true);
    expect(publishRequestSchema.safeParse(request([])).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => String(i));
    expect(publishRequestSchema.safeParse(request(many)).success).toBe(false);
    expect(
      workspaceSchema.safeParse({
        ...(from003() as object),
        publishRequests: [request(['a']), { ...request(['b']), id: uuid(8) }],
      }).success,
    ).toBe(false);
  });

  it('reads a draft of 003 with « orchestrator: true » as the orchestrator role', () => {
    const base = {
      cliId: 'claude-code',
      model: null,
      permissionLevel: 'always-allow',
      baseBranch: null,
      branch: null,
      port: null,
      startCommand: null,
    };
    expect(draftRole(agentDraftSchema.parse({ ...base, orchestrator: true }))).toBe('orchestrator');
    expect(draftRole(agentDraftSchema.parse({ ...base, role: 'dev', effort: 'high' }))).toBe('dev');
    expect(draftRole(agentDraftSchema.parse(base))).toBeNull();
    expect(agentDraftSchema.safeParse({ ...base, role: 'chef' }).success).toBe(false);
  });
});

// 006 T003 — which orchestrator launched an agent (data-model « Agent »).
describe('Agent.launchedBy (006)', () => {
  it('reads null for an agent saved without the field', () => {
    const parsed = agentSchema.safeParse(agent(1));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ launchedBy: null });
  });

  it('accepts the uuid of the orchestrator that launched it', () => {
    const parsed = agentSchema.safeParse({ ...agent(2), launchedBy: uuid(1) });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ launchedBy: uuid(1) });
  });

  it('refuses a number', () => {
    expect(agentSchema.safeParse({ ...agent(2), launchedBy: 1 }).success).toBe(false);
  });

  it('is kept in a workspace read back from the state', () => {
    const parsed = workspaceSchema.safeParse(
      workspace([agent(1, { role: 'orchestrator' }), { ...agent(2), launchedBy: uuid(1) }]),
    );
    expect(parsed.data?.agents.map((a) => (a as { launchedBy?: unknown }).launchedBy)).toEqual([
      null,
      uuid(1),
    ]);
  });
});
