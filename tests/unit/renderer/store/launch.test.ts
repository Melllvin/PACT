import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcOutput, PactApi } from '../../../../src/shared/ipc';
import type {
  Agent,
  CliDefinition,
  PermissionPreference,
  Workspace,
} from '../../../../src/shared/model';

// US2 — « + Agents » → mode rapide (1c) → autorisations (1m) au premier lancement → agents:launch.

const cli = (id: 'claude-code' | 'codex'): CliDefinition => ({
  id,
  name: id === 'codex' ? 'Codex' : 'Claude Code',
  adapter: id,
  command: id === 'codex' ? 'codex' : 'claude',
  resolvedPath: `/bin/${id}`,
  version: '1.0.0',
  origin: 'detected',
  status: 'installed',
  models: [],
});

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  path: '/w1',
  name: 'w1',
  mainBranch: 'main',
  agents: [],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
  ...overrides,
});

const launchedAgent = { id: '00000000-0000-4000-8000-000000000001' } as Agent;

function setup({
  permission = null,
  ws = workspace(),
  launch = () => Promise.resolve([launchedAgent]),
}: {
  permission?: PermissionPreference | null;
  ws?: Workspace;
  launch?: () => Promise<unknown>;
} = {}) {
  let snapshot: IpcOutput<'app:getState'> = {
    workspaces: [ws],
    recents: [],
    clis: [cli('claude-code'), cli('codex')],
    permission,
  };
  const invoke = vi.fn((channel: string, input?: unknown) => {
    switch (channel) {
      case 'app:getState':
        return Promise.resolve(snapshot);
      case 'agents:launch':
        return launch();
      case 'permission:set':
        return Promise.resolve(undefined);
      case 'cli:redetect':
        return Promise.resolve([cli('codex')]);
      default:
        return Promise.reject(new Error(`unexpected ${channel} ${JSON.stringify(input)}`));
    }
  });
  const api = { invoke, on: () => () => undefined } as unknown as PactApi;
  const store = createAppStore(api);
  const setSnapshot = (next: Partial<IpcOutput<'app:getState'>>) => {
    snapshot = { ...snapshot, ...next };
  };
  return { store, invoke, setSnapshot };
}

const counts = { agents: { 'claude-code': 2, codex: 1 }, freeTerminal: 1 };

describe('launch flow', () => {
  it('opens and closes the quick launcher of a workspace', async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    expect(store.getState().launcher).toEqual({ workspaceId: 'w1', step: 'counts' });
    store.getState().closeLauncher();
    expect(store.getState().launcher).toBeNull();
  });

  it('asks for the permission level on the very first launch (1m)', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(counts);
    expect(store.getState().launcher).toEqual({ workspaceId: 'w1', step: 'permission', counts });
    expect(invoke).not.toHaveBeenCalledWith('agents:launch', expect.anything());
  });

  it('saves the choice, then launches with its level', async () => {
    const { store, invoke, setSnapshot } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(counts);
    setSnapshot({ workspaces: [workspace({ agents: [launchedAgent] })] });
    await store
      .getState()
      .confirmPermission({ level: 'ask-sensitive', autoResume: true, scope: 'global' });

    expect(invoke).toHaveBeenCalledWith('permission:set', {
      level: 'ask-sensitive',
      autoResume: true,
      scope: 'global',
    });
    const launch = invoke.mock.calls.find(([channel]) => channel === 'agents:launch')?.[1];
    expect(launch).toMatchObject({
      workspaceId: 'w1',
      freeTerminals: 1,
      counters: { freeTerminal: 1, 'claude-code': 2, codex: 1 },
    });
    const drafts = (launch as { agents: { cliId: string; permissionLevel: string }[] }).agents;
    expect(drafts.map((d) => d.cliId)).toEqual(['claude-code', 'claude-code', 'codex']);
    expect(drafts.every((d) => d.permissionLevel === 'ask-sensitive')).toBe(true);
    expect(drafts[0]).toMatchObject({ model: null, baseBranch: null, branch: null, port: null });

    expect(store.getState().permission).toMatchObject({ level: 'ask-sensitive' });
    expect(store.getState().launcher).toBeNull();
    expect(store.getState().workspaces[0]?.agents).toEqual([launchedAgent]);
  });

  it('keeps a « Ce projet » choice on the workspace only', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(counts);
    await store
      .getState()
      .confirmPermission({ level: 'always-ask', autoResume: false, scope: 'project' });
    expect(invoke).toHaveBeenCalledWith('permission:set', {
      level: 'always-ask',
      autoResume: false,
      scope: 'project',
      workspaceId: 'w1',
    });
    expect(store.getState().permission).toBeNull();
  });

  it('launches straight away once a level is known, the project one first', async () => {
    const { store, invoke } = setup({
      permission: { level: 'always-allow', autoResume: true, scope: 'global' },
      ws: workspace({
        permissionOverride: { level: 'always-ask', autoResume: true, scope: 'project' },
      }),
    });
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch({ agents: { codex: 1 }, freeTerminal: 0 });
    const launch = invoke.mock.calls.find(([channel]) => channel === 'agents:launch')?.[1];
    expect(launch).toMatchObject({ agents: [{ cliId: 'codex', permissionLevel: 'always-ask' }] });
    expect(invoke).not.toHaveBeenCalledWith('permission:set', expect.anything());
  });

  it('shows a refused launch in the launcher (LIMIT)', async () => {
    const { store } = setup({
      permission: { level: 'always-allow', autoResume: true, scope: 'global' },
      launch: () => Promise.reject({ code: 'LIMIT', message: 'Six agents au plus par projet.' }),
    });
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(counts);
    expect(store.getState().launcher).toEqual({
      workspaceId: 'w1',
      step: 'counts',
      error: 'Six agents au plus par projet.',
    });
  });

  it('detects the CLIs again on request', async () => {
    const { store } = setup();
    await store.getState().load();
    await store.getState().redetectClis();
    expect(store.getState().clis.map((c) => c.id)).toEqual(['codex']);
  });
});
