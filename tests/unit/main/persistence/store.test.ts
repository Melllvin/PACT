import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFile, openStores, SCHEMA_VERSION } from '../../../../src/main/persistence/store';

const schema = z.object({ count: z.int(), label: z.string() });
const defaults = () => ({ count: 0, label: 'default' });

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-store-'));
  path = join(dir, 'data.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => new JsonFile(path, schema, defaults);
const writeRaw = (content: string) => writeFile(path, content, 'utf8');

describe('JsonFile', () => {
  it('returns the defaults when the file does not exist, without creating it', async () => {
    expect(await file().read()).toEqual(defaults());
    expect(await readdir(dir)).toEqual([]);
  });

  it('round-trips a value and stamps the schema version', async () => {
    await file().write({ count: 3, label: 'x' });
    expect(await file().read()).toEqual({ count: 3, label: 'x' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: SCHEMA_VERSION,
      data: { count: 3, label: 'x' },
    });
  });

  it('creates missing parent directories', async () => {
    path = join(dir, 'nested', 'deeper', 'data.json');
    await file().write({ count: 1, label: 'x' });
    expect(await file().read()).toEqual({ count: 1, label: 'x' });
  });

  it('refuses to write an invalid value', async () => {
    await expect(file().write({ count: 1.5, label: 'x' })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps the last value and leaves no temporary file under concurrent writes', async () => {
    const store = file();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.write({ count: i, label: `v${String(i)}` })),
    );
    expect(await store.read()).toEqual({ count: 24, label: 'v24' });
    expect(await readdir(dir)).toEqual(['data.json']);
  });

  it.each([
    ['corrupted JSON', '{"schemaVersion": 1, "data": {'],
    ['a value that fails the schema', JSON.stringify({ schemaVersion: 1, data: { count: 'x' } })],
    ['an unknown schema version', JSON.stringify({ schemaVersion: 99, data: defaults() })],
    ['a legacy unversioned file', JSON.stringify({ count: 2, label: 'old' })],
  ])('falls back to the defaults on %s and keeps a backup of the file', async (_case, content) => {
    await writeRaw(content);
    expect(await file().read()).toEqual(defaults());

    const backups = (await readdir(dir)).filter((name) => name.startsWith('data.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0] ?? ''), 'utf8')).toBe(content);
  });

  it('never overwrites a backup when the file is written again', async () => {
    await writeRaw('not json');
    const store = file();
    await store.read();
    await store.write({ count: 1, label: 'fresh' });
    const names = await readdir(dir);
    expect(names.filter((name) => name.startsWith('data.json.corrupt-'))).toHaveLength(1);
    expect(await store.read()).toEqual({ count: 1, label: 'fresh' });
  });

  it('surfaces read errors other than a missing file instead of masking them', async () => {
    await mkdir(path); // reading a directory fails with EISDIR on every platform
    await expect(file().read()).rejects.toThrow();
  });
});

describe('openStores', () => {
  it('keeps global state in state.json and each workspace in workspaces/<id>.json', () => {
    const stores = openStores(dir);
    expect(stores.state.path).toBe(join(dir, 'state.json'));
    expect(stores.workspace('a1b2c3').path).toBe(join(dir, 'workspaces', 'a1b2c3.json'));
  });

  it('starts with an empty global state', async () => {
    expect(await openStores(dir).state.read()).toEqual({
      openWorkspaces: [],
      recents: [],
      customClis: [],
      permission: null,
      usageThresholds: { warn: 80, critical: 95 },
      usageStops: {},
      usageLimit: { saves: [], overrides: [], declined: [], resumed: [] },
    });
  });

  // 005 T005 — the usage thresholds, read without migration from a state saved before 005.
  it('reads the usage thresholds of a state saved before 005 as the defaults', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        data: { openWorkspaces: ['/a'], recents: [], customClis: [], permission: null },
      }),
    );
    const state = await openStores(dir).state.read();
    expect(state.openWorkspaces).toEqual(['/a']);
    expect(state.usageThresholds).toEqual({ warn: 80, critical: 95 });
  });

  it('keeps usage thresholds that were set', async () => {
    const stores = openStores(dir);
    const state = await stores.state.read();
    await stores.state.write({ ...state, usageThresholds: { warn: 70, critical: 90 } });
    expect((await openStores(dir).state.read()).usageThresholds).toEqual({
      warn: 70,
      critical: 90,
    });
  });

  it.each([
    { warn: 95, critical: 80 },
    { warn: 0, critical: 95 },
    { warn: 80, critical: 101 },
    { warn: 80.5, critical: 95 },
  ])('refuses the usage thresholds %j', async (usageThresholds) => {
    const stores = openStores(dir);
    const state = await stores.state.read();
    await expect(stores.state.write({ ...state, usageThresholds })).rejects.toThrow();
  });

  it.each(['../escape', 'a/b', '', 'UPPER'])('rejects the workspace id %j', (id) => {
    expect(() => openStores(dir).workspace(id)).toThrow();
  });

  it('returns the same store for the same workspace so writes are serialized', () => {
    const stores = openStores(dir);
    expect(stores.workspace('abc')).toBe(stores.workspace('abc'));
  });
});

// 009 T007 — the stop at a limit adds to the stored files, with defaults and no migration (data-model
// « Storage »).

describe('openStores — usage limit (009)', () => {
  const emptyLimit = { saves: [], overrides: [], declined: [], resumed: [] };
  const agentOnDisk = {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'abc123',
    position: 1,
    color: 'purple',
    cliId: 'claude-code',
    model: null,
    permissionLevel: 'always-allow',
    baseBranch: 'main',
    branch: 'agent/claude-code-1',
    worktreePath: '/repo/.worktrees/claude-code-1',
    port: 3001,
    startCommand: null,
    sessionId: null,
    initialPrompt: null,
    alwaysAllowRules: [],
    state: 'awaiting-prompt',
    lastError: null,
    scheduledResume: null,
    review: { seen: {}, comments: [] },
    role: null,
    launchedBy: null,
    closedWhileWorking: false,
    effort: null,
  };
  const workspaceOnDisk = (agents: unknown[]) => ({
    id: 'abc123',
    path: '/repo',
    name: 'repo',
    mainBranch: 'main',
    agents,
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    lastOpenedAt: '2026-11-08T10:00:00.000Z',
    status: 'available',
  });
  const writeWorkspace = async (agents: unknown[]) => {
    await mkdir(join(dir, 'workspaces'), { recursive: true });
    await writeFile(
      join(dir, 'workspaces', 'abc123.json'),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, data: workspaceOnDisk(agents) }),
    );
  };

  it('reads a state saved before 009 with no stop and an empty usageLimit', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        data: {
          openWorkspaces: ['/a'],
          recents: [],
          customClis: [],
          permission: null,
          usageThresholds: { warn: 70, critical: 90 },
        },
      }),
    );
    const state = await openStores(dir).state.read();
    expect(state.openWorkspaces).toEqual(['/a']);
    expect(state.usageThresholds).toEqual({ warn: 70, critical: 90 });
    expect(state.usageStops).toEqual({});
    expect(state.usageLimit).toEqual(emptyLimit);
  });

  it('starts with no stop and an empty usageLimit', async () => {
    const state = await openStores(dir).state.read();
    expect(state.usageStops).toEqual({});
    expect(state.usageLimit).toEqual(emptyLimit);
  });

  it('round-trips the stops and the usageLimit', async () => {
    const stores = openStores(dir);
    const state = await stores.state.read();
    const usageStops = { 'claude-code': { week: 80, 'five-hour': 100 } };
    const usageLimit = {
      ...emptyLimit,
      resumed: [{ cliId: 'claude-code', account: 'default', at: '2026-11-08T10:00:00.000Z' }],
    };
    await stores.state.write({ ...state, usageStops, usageLimit });
    const read = await openStores(dir).state.read();
    expect(read.usageStops).toEqual(usageStops);
    expect(read.usageLimit).toEqual(usageLimit);
  });

  it.each([{ 'claude-code': { week: 9 } }, { 'claude-code': { week: 101 } }])(
    'refuses the stops %j',
    async (usageStops) => {
      const stores = openStores(dir);
      const state = await stores.state.read();
      await expect(stores.state.write({ ...state, usageStops })).rejects.toThrow();
    },
  );

  it('reads an agent saved before 009 with pause: null', async () => {
    await writeWorkspace([agentOnDisk]);
    const workspace = await openStores(dir).workspace('abc123').read();
    expect(workspace?.agents[0]).toMatchObject({ id: agentOnDisk.id, pause: null });
  });

  it('keeps the pause of a paused agent through a write and a read', async () => {
    const pause = {
      cliId: 'claude-code',
      account: 'default',
      cause: 'threshold',
      windows: [
        { id: 'five-hour', label: '5 h', percent: 91, resetsAt: '2026-11-08T14:00:00.000Z' },
      ],
      resumeAt: '2026-11-08T14:00:00.000Z',
      pausedAt: '2026-11-08T10:00:00.000Z',
      midTurn: true,
      saved: false,
      closedQuestion: null,
      blocked: null,
    };
    await writeWorkspace([{ ...agentOnDisk, state: 'paused', pause }]);
    const workspace = await openStores(dir).workspace('abc123').read();
    expect(workspace?.agents[0]).toMatchObject({ state: 'paused', pause });
  });
});
