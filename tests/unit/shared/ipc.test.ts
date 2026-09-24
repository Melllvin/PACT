import { describe, expect, it } from 'vitest';
import {
  IPC_ERROR_CODES,
  ipcErrorSchema,
  ipcEvents,
  ipcRequests,
  toIpcError,
  type IpcRequestChannel,
} from '../../../src/shared/ipc';

const agentId = '00000000-0000-4000-8000-000000000001';
const draft = {
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
};

const absolute =
  process.platform === 'win32'
    ? 'C:\\Users\\me\\Développement\\repo'
    : '/Users/me/Développement/repo';

// For every request channel of contracts/ipc.md: one valid input and invalid ones.
const requestCases: Record<IpcRequestChannel, { valid: unknown; invalid: unknown[] }> = {
  'app:getState': { valid: undefined, invalid: [{ extra: true }] },
  'workspace:open': {
    valid: { path: absolute },
    invalid: [{}, { path: '' }, { path: 'relative/repo' }],
  },
  'workspace:initRepo': { valid: { path: absolute }, invalid: [{ path: 42 }] },
  'workspace:clone': {
    valid: { url: 'git@github.com:me/repo.git', destination: absolute },
    invalid: [
      { url: '', destination: absolute },
      { url: 'x', destination: 'rel' },
    ],
  },
  'workspace:close': { valid: { id: 'abc' }, invalid: [{ id: '' }] },
  'dialog:pickFolder': {
    valid: { purpose: 'open-repository' },
    invalid: [{ purpose: 'anything' }, {}],
  },
  'cli:add': {
    valid: { name: 'Aider', command: 'aider --model x' },
    invalid: [
      { name: '', command: 'aider' },
      { name: 'Aider', command: '  ' },
    ],
  },
  'cli:redetect': { valid: undefined, invalid: [{ force: true }] },
  'permission:set': {
    valid: { level: 'ask-sensitive', autoResume: false, scope: 'project', workspaceId: 'w1' },
    invalid: [{ level: 'bypass', autoResume: true, scope: 'global' }, { scope: 'project' }],
  },
  'agents:launch': {
    valid: {
      workspaceId: 'w1',
      agents: [draft, { ...draft, branch: 'feature/x', port: 4000, model: 'opus' }],
      freeTerminals: 1,
      counters: { freeTerminal: 1, 'claude-code': 2 },
    },
    invalid: [
      {
        workspaceId: 'w1',
        agents: Array(7).fill(draft),
        freeTerminals: 0,
        counters: { freeTerminal: 0 },
      },
      {
        workspaceId: 'w1',
        agents: [{ ...draft, port: 0 }],
        freeTerminals: 0,
        counters: { freeTerminal: 0 },
      },
      { workspaceId: 'w1', agents: [draft], freeTerminals: -1, counters: { freeTerminal: 0 } },
    ],
  },
  'agents:reorder': {
    valid: { workspaceId: 'w1', order: [agentId] },
    invalid: [{ workspaceId: 'w1', order: ['x'] }],
  },
  'agent:answer': {
    valid: { agentId, answer: 'allow', always: true },
    invalid: [
      { agentId, answer: 'maybe' },
      { agentId: 'x', answer: 'deny' },
    ],
  },
  'agent:resume': { valid: { agentId }, invalid: [{}] },
  'agent:restart': { valid: { agentId }, invalid: [{ agentId: 1 }] },
  'agent:close': { valid: { agentId, removeWorktree: false }, invalid: [{ agentId }] },
  'agent:cancelAutoResume': { valid: { agentId }, invalid: [{ agentId: '' }] },
  'agent:log': { valid: { agentId }, invalid: [null] },
  'term:write': {
    valid: { termId: 't1', data: 'ls\r' },
    invalid: [{ termId: 't1' }, { termId: '', data: 'x' }],
  },
  'term:resize': {
    valid: { termId: 't1', cols: 120, rows: 40 },
    invalid: [
      { termId: 't1', cols: 0, rows: 40 },
      { termId: 't1', cols: 80.5, rows: 24 },
    ],
  },
};

describe('IPC request schemas', () => {
  it('cover exactly the channels of contracts/ipc.md', () => {
    expect(Object.keys(ipcRequests).sort()).toEqual(Object.keys(requestCases).sort());
  });

  for (const [channel, { valid, invalid }] of Object.entries(requestCases)) {
    it(`${channel} accepts a valid input and rejects invalid ones`, () => {
      const { input } = ipcRequests[channel as IpcRequestChannel];
      expect(input.safeParse(valid).success).toBe(true);
      for (const bad of invalid) expect(input.safeParse(bad).success).toBe(false);
    });
  }

  it('rejects oversized terminal writes', () => {
    const { input } = ipcRequests['term:write'];
    expect(input.safeParse({ termId: 't1', data: 'x'.repeat(1_000_001) }).success).toBe(false);
  });

  it('validates the app:getState output', () => {
    const { output } = ipcRequests['app:getState'];
    expect(
      output.safeParse({ workspaces: [], recents: [], clis: [], permission: null }).success,
    ).toBe(true);
    expect(output.safeParse({ workspaces: [], recents: [], clis: [] }).success).toBe(false);
  });
});

describe('IPC event schemas', () => {
  it('cover exactly the events of contracts/ipc.md', () => {
    expect(Object.keys(ipcEvents).sort()).toEqual([
      'agent:branch',
      'agent:state',
      'clone:progress',
      'term:data',
      'term:exit',
      'workspace:status',
    ]);
  });

  it('accept progress and failure clone events', () => {
    const schema = ipcEvents['clone:progress'];
    expect(schema.safeParse({ jobId: 'j', percent: 42, phase: 'Receiving objects' }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ jobId: 'j', error: { code: 'CLONE_FAILED', message: 'x' } }).success,
    ).toBe(true);
    expect(schema.safeParse({ jobId: 'j', percent: 142, phase: 'x' }).success).toBe(false);
  });

  it('announce the opened workspace when a clone completes (US1 scenario 2)', () => {
    const workspace = {
      id: 'abc',
      path: '/repo',
      name: 'repo',
      mainBranch: 'main',
      agents: [],
      freeTerminals: [],
      quickLaunchCounters: { freeTerminal: 0 },
      permissionOverride: null,
      lastOpenedAt: '2026-09-24T10:00:00.000Z',
      status: 'available',
    };
    expect(ipcEvents['clone:progress'].safeParse({ jobId: 'j', workspace }).success).toBe(true);
  });

  it('accept agent state changes', () => {
    expect(ipcEvents['agent:state'].safeParse({ agentId, state: 'awaiting-answer' }).success).toBe(
      true,
    );
    expect(ipcEvents['agent:state'].safeParse({ agentId, state: 'sleeping' }).success).toBe(false);
  });
});

describe('IPC errors', () => {
  it('are { code, message } with a known code', () => {
    expect(
      ipcErrorSchema.safeParse({ code: 'NOT_A_REPO', message: 'Pas un dépôt Git' }).success,
    ).toBe(true);
    expect(ipcErrorSchema.safeParse({ code: 'OOPS', message: 'x' }).success).toBe(false);
    expect(IPC_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'NOT_A_REPO',
        'ALREADY_OPEN',
        'LIMIT',
        'BRANCH_CONFLICT',
        'PORT_CONFLICT',
      ]),
    );
  });

  it('carry the existing workspace id for ALREADY_OPEN (FR-004)', () => {
    expect(
      ipcErrorSchema.safeParse({ code: 'ALREADY_OPEN', message: 'Déjà ouvert', workspaceId: 'w1' })
        .success,
    ).toBe(true);
  });

  it('normalize unknown throwables into INTERNAL errors', () => {
    expect(toIpcError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(toIpcError('weird')).toEqual({ code: 'INTERNAL', message: 'Erreur inattendue' });
  });

  it('keep already normalized errors untouched', () => {
    const error = { code: 'LIMIT', message: '6 agents au plus' } as const;
    expect(toIpcError(error)).toEqual(error);
  });
});

describe('IpcFailure', () => {
  it('carries a code and an optional workspace id through toIpcError', async () => {
    const { IpcFailure } = await import('../../../src/shared/ipc');
    expect(toIpcError(new IpcFailure('ALREADY_OPEN', 'Déjà ouvert', 'w1'))).toEqual({
      code: 'ALREADY_OPEN',
      message: 'Déjà ouvert',
      workspaceId: 'w1',
    });
    expect(toIpcError(new IpcFailure('LIMIT', '6 agents au plus'))).toEqual({
      code: 'LIMIT',
      message: '6 agents au plus',
    });
  });
});
