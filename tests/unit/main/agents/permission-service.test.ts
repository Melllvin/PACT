import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionService } from '../../../../src/main/agents/permission-service';
import { openStores, type Stores } from '../../../../src/main/persistence/store';
import type { Workspace } from '../../../../src/shared/model';

// FR-012, FR-035 — screen 1m choice: project > global > ask (show 1m).

const workspace: Workspace = {
  id: 'abcdef0123456789',
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

/** Minimal in-memory stand-in for the WorkspaceService methods the service uses. */
const workspaceAccess = (initial: Workspace[]) => {
  const map = new Map(initial.map((w) => [w.id, w]));
  return {
    get: (id: string) => map.get(id),
    update: (id: string, change: (w: Workspace) => Workspace) => {
      const current = map.get(id);
      if (!current) throw new Error('unknown');
      const next = change(current);
      map.set(id, next);
      return Promise.resolve(next);
    },
  };
};

let dir: string;
let stores: Stores;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-permission-'));
  stores = openStores(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PermissionService', () => {
  it('asks (shows 1m) when nothing was chosen yet', async () => {
    const service = new PermissionService({ stores, workspaces: workspaceAccess([workspace]) });
    expect(await service.resolve(workspace.id)).toBeNull();
  });

  it('remembers a « Tous les projets » choice in state.json', async () => {
    const service = new PermissionService({ stores, workspaces: workspaceAccess([workspace]) });
    await service.set({ level: 'ask-sensitive', autoResume: false, scope: 'global' });
    expect(await service.resolve(workspace.id)).toEqual({
      level: 'ask-sensitive',
      autoResume: false,
      scope: 'global',
    });
    expect((await stores.state.read()).permission).toMatchObject({ level: 'ask-sensitive' });
    expect(await service.global()).toMatchObject({ level: 'ask-sensitive' });
  });

  it('prefers the « Ce projet » choice, stored in the workspace', async () => {
    const workspaces = workspaceAccess([workspace]);
    const service = new PermissionService({ stores, workspaces });
    await service.set({ level: 'always-allow', autoResume: true, scope: 'global' });
    await service.set({
      level: 'always-ask',
      autoResume: true,
      scope: 'project',
      workspaceId: workspace.id,
    });
    expect(await service.resolve(workspace.id)).toMatchObject({
      level: 'always-ask',
      scope: 'project',
    });
    expect(workspaces.get(workspace.id)?.permissionOverride).toMatchObject({ level: 'always-ask' });
    expect(await service.resolve('0000000000000000')).toMatchObject({ level: 'always-allow' });
  });

  it('refuses a project choice without a known workspace', async () => {
    const service = new PermissionService({ stores, workspaces: workspaceAccess([]) });
    await expect(
      service.set({ level: 'always-allow', autoResume: true, scope: 'project' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.set({ level: 'always-allow', autoResume: true, scope: 'project', workspaceId: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resumes automatically after a rate limit unless told otherwise (FR-035)', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        data: {
          openWorkspaces: [],
          recents: [],
          customClis: [],
          permission: { level: 'always-allow', scope: 'global' },
        },
      }),
    );
    const service = new PermissionService({
      stores: openStores(dir),
      workspaces: workspaceAccess([workspace]),
    });
    expect((await service.resolve(workspace.id))?.autoResume).toBe(true);
  });
});
