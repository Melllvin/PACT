import { IpcFailure } from '../../shared/ipc';
import type { PermissionLevel, PermissionPreference, Workspace } from '../../shared/model';
import type { Stores } from '../persistence/store';

// FR-012, FR-035 — the screen 1m choice, resolved project > global > ask.

/** The WorkspaceService methods the preference needs. */
type WorkspaceAccess = {
  get(id: string): Workspace | undefined;
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

export type PermissionChoice = {
  level: PermissionLevel;
  autoResume: boolean;
  scope: PermissionPreference['scope'];
  workspaceId?: string;
};

type Options = { stores: Stores; workspaces: WorkspaceAccess };

export class PermissionService {
  private readonly stores: Stores;
  private readonly workspaces: WorkspaceAccess;

  constructor({ stores, workspaces }: Options) {
    this.stores = stores;
    this.workspaces = workspaces;
  }

  /** Preference for a launch in that workspace, or null when screen 1m must ask. */
  async resolve(workspaceId: string): Promise<PermissionPreference | null> {
    return this.workspaces.get(workspaceId)?.permissionOverride ?? (await this.global());
  }

  async global(): Promise<PermissionPreference | null> {
    return (await this.stores.state.read()).permission;
  }

  async set({ level, autoResume, scope, workspaceId }: PermissionChoice): Promise<void> {
    const preference: PermissionPreference = { level, autoResume, scope };
    if (scope === 'global') {
      const state = await this.stores.state.read();
      await this.stores.state.write({ ...state, permission: preference });
      return;
    }
    if (workspaceId === undefined) {
      throw new IpcFailure('INVALID_INPUT', 'Le choix « Ce projet » demande un workspace.');
    }
    if (!this.workspaces.get(workspaceId)) {
      throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    }
    await this.workspaces.update(workspaceId, (workspace) => ({
      ...workspace,
      permissionOverride: preference,
    }));
  }
}
