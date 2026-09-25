import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import { draftFromCounts, setOverride } from '../../../../src/shared/launch-draft';
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
  setPermission = () => Promise.resolve(undefined),
}: {
  permission?: PermissionPreference | null;
  ws?: Workspace;
  launch?: () => Promise<unknown>;
  setPermission?: () => Promise<unknown>;
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
        return setPermission();
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

const draft = draftFromCounts({ 'claude-code': 2, codex: 1 }, 1);

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
    await store.getState().requestLaunch(draft);
    expect(store.getState().launcher).toEqual({ workspaceId: 'w1', step: 'permission', draft });
    expect(invoke).not.toHaveBeenCalledWith('agents:launch', expect.anything());
  });

  it('saves the choice, then launches with its level', async () => {
    const { store, invoke, setSnapshot } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draft);
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

  it('keeps what the detailed mode set through the permission step (US6)', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(setOverride(draft, 2, 'startCommand', 'npm run dev'));
    await store
      .getState()
      .confirmPermission({ level: 'always-allow', autoResume: true, scope: 'global' });
    const launch = invoke.mock.calls.find(([channel]) => channel === 'agents:launch')?.[1];
    const drafts = (launch as { agents: { startCommand: string | null }[] }).agents;
    expect(drafts.map((d) => d.startCommand)).toEqual([null, null, 'npm run dev']);
  });

  it('keeps a « Ce projet » choice on the workspace only', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draft);
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
    await store.getState().requestLaunch(draftFromCounts({ codex: 1 }, 0));
    const launch = invoke.mock.calls.find(([channel]) => channel === 'agents:launch')?.[1];
    expect(launch).toMatchObject({ agents: [{ cliId: 'codex', permissionLevel: 'always-ask' }] });
    expect(invoke).not.toHaveBeenCalledWith('permission:set', expect.anything());
  });

  it('remembers a zero for every installed CLI, so a terminal alone is launched again (FR-010)', async () => {
    const { store, invoke } = setup({
      permission: { level: 'always-allow', autoResume: true, scope: 'global' },
    });
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draftFromCounts({}, 1));
    const launch = invoke.mock.calls.find(([channel]) => channel === 'agents:launch')?.[1];
    expect(launch).toMatchObject({
      counters: { freeTerminal: 1, 'claude-code': 0, codex: 0 },
    });
  });

  it('shows a refused launch in the launcher (LIMIT)', async () => {
    const { store } = setup({
      permission: { level: 'always-allow', autoResume: true, scope: 'global' },
      // IPC failures cross the bridge as plain objects, not Errors.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      launch: () => Promise.reject({ code: 'LIMIT', message: 'Six agents au plus par projet.' }),
    });
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draft);
    expect(store.getState().launcher).toEqual({
      workspaceId: 'w1',
      step: 'counts',
      draft,
      error: 'Six agents au plus par projet.',
    });
  });

  it('opens free terminals alone without asking for a permission level', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draftFromCounts({}, 2));
    expect(invoke).toHaveBeenCalledWith(
      'agents:launch',
      expect.objectContaining({ agents: [], freeTerminals: 2 }),
    );
    expect(store.getState().launcher).toBeNull();
  });

  it('goes back to the launcher when the choice cannot be saved', async () => {
    const { store, invoke } = setup({
      setPermission: () => Promise.reject(new Error('Disque plein')),
    });
    await store.getState().load();
    store.getState().openLauncher('w1');
    await store.getState().requestLaunch(draft);
    await store
      .getState()
      .confirmPermission({ level: 'always-allow', autoResume: true, scope: 'global' });
    expect(store.getState().launcher).toEqual({
      workspaceId: 'w1',
      step: 'counts',
      draft,
      error: 'Disque plein',
    });
    expect(invoke).not.toHaveBeenCalledWith('agents:launch', expect.anything());
  });

  it('does nothing without an open launcher or a pending permission step', async () => {
    const { store, invoke } = setup();
    await store.getState().load();
    await store.getState().requestLaunch(draft);
    await store
      .getState()
      .confirmPermission({ level: 'always-allow', autoResume: true, scope: 'global' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('detects the CLIs again on request', async () => {
    const { store } = setup();
    await store.getState().load();
    await store.getState().redetectClis();
    expect(store.getState().clis.map((c) => c.id)).toEqual(['codex']);
  });
});
