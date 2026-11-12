import { deliverySettingsSchema, type DeliverySettings } from '../../shared/delivery';
import { IpcFailure, type IpcInput } from '../../shared/ipc';
import type { Workspace } from '../../shared/model';
import type { WorktreeCleanup } from '../delivery/cleanup';
import type { DeliveryService } from '../delivery/delivery-service';

// 008 contracts/ui.md — `delivery:settings`: the settings of the delivery of a project (FR-019, FR-020),
// saved in the workspace; the delivery is told once they are written (FR-011).

type Dependencies = {
  workspaces: {
    get(id: string): Workspace | undefined;
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
  delivery: Pick<DeliveryService, 'settingsChanged'>;
  /** 008 US8 — the worktrees the cleanup kept (`DeliveryService.worktreeCleanup`). */
  cleanup?: Pick<WorktreeCleanup, 'lost' | 'force' | 'keep'>;
  /** `shell.openExternal`: absent in the suites that do not open anything. */
  openExternal?: (url: string) => Promise<void>;
  /** The address of the PR of a delivery, rebuilt by the delivery (`DeliveryService.prUrl`). */
  prUrl?: (deliveryId: string) => Promise<string | null>;
  /** `workspace:deliveries` to the renderer. */
  onChange?: (
    workspaceId: string,
    change: { deliveries: Workspace['deliveries']; delivery: DeliverySettings },
  ) => void;
};

const sameLines = (seen: string[] | undefined, lost: string[]) =>
  seen !== undefined && seen.length === lost.length && seen.every((line, i) => line === lost[i]);

export function createDeliveryServices({
  workspaces,
  delivery,
  cleanup,
  onChange,
  openExternal,
  prUrl,
}: Dependencies) {
  return {
    'delivery:openPr': async ({ deliveryId }: IpcInput<'delivery:openPr'>): Promise<void> => {
      const url = (await prUrl?.(deliveryId)) ?? null;
      if (url === null) {
        throw new IpcFailure('NOT_FOUND', 'Aucune PR à ouvrir pour cette livraison.');
      }
      await openExternal?.(url);
    },
    'delivery:cleanup': async ({
      deliveryId,
      agentId,
      decision,
      confirmed,
      seen,
    }: IpcInput<'delivery:cleanup'>): Promise<{ lost: string[] }> => {
      if (!cleanup) throw new IpcFailure('NOT_FOUND', 'Aucun nettoyage de worktree disponible.');
      if (decision === 'keep') {
        await cleanup.keep(deliveryId, agentId);
        return { lost: [] };
      }
      // « Supprimer quand même » is two steps: what would be lost first, the deletion once confirmed.
      const lost = await cleanup.lost(deliveryId, agentId);
      if (lost === null) {
        throw new IpcFailure('NOT_FOUND', 'Aucun worktree gardé pour cet agent.');
      }
      // R1 — the confirmation is bound to what the user saw: a changed list is shown again, never deleted.
      if (confirmed === true && sameLines(seen, lost)) await cleanup.force(deliveryId, agentId);
      return { lost };
    },
    'delivery:settings': async ({
      workspaceId,
      settings,
    }: IpcInput<'delivery:settings'>): Promise<DeliverySettings> => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace introuvable.');
      // Only the keys given change, the others keep their value; the bounds are those of the schema.
      const given = Object.fromEntries(
        Object.entries(settings).filter(([, value]) => value !== undefined),
      );
      const parsed = deliverySettingsSchema.safeParse({ ...workspace.delivery, ...given });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') ?? '';
        throw new IpcFailure(
          'INVALID_INPUT',
          `${field === '' ? 'Réglage' : field} : ${issue?.message ?? 'valeur invalide'}.`,
        );
      }
      const saved = await workspaces.update(workspaceId, (current) => ({
        ...current,
        delivery: parsed.data,
      }));
      onChange?.(workspaceId, { deliveries: saved.deliveries, delivery: saved.delivery });
      await delivery.settingsChanged(workspaceId);
      return saved.delivery;
    },
  };
}
