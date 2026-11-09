import { deliverySettingsSchema, type DeliverySettings } from '../../shared/delivery';
import { IpcFailure, type IpcInput } from '../../shared/ipc';
import type { Workspace } from '../../shared/model';
import type { DeliveryService } from '../delivery/delivery-service';

// 008 contracts/ui.md — `delivery:settings`: the settings of the delivery of a project (FR-019, FR-020),
// saved in the workspace; the delivery is told once they are written (FR-011).

/** The PR of a delivery on the forge: the only address the main process opens for the renderer. */
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

type Dependencies = {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
  delivery: Pick<DeliveryService, 'settingsChanged'>;
  /** `shell.openExternal`: absent in the suites that do not open anything. */
  openExternal?: (url: string) => Promise<void>;
  /** `workspace:deliveries` to the renderer. */
  onChange?: (
    workspaceId: string,
    change: { deliveries: Workspace['deliveries']; delivery: DeliverySettings },
  ) => void;
};

export function createDeliveryServices({
  workspaces,
  delivery,
  onChange,
  openExternal,
}: Dependencies) {
  return {
    'delivery:openPr': async ({ deliveryId }: IpcInput<'delivery:openPr'>): Promise<void> => {
      const found = workspaces
        .list()
        .flatMap((w) => w.deliveries)
        .find((d) => d.id === deliveryId);
      const url = found?.pr?.url;
      if (url === undefined || !PR_URL.test(url)) {
        throw new IpcFailure('NOT_FOUND', 'Aucune PR à ouvrir pour cette livraison.');
      }
      await openExternal?.(url);
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
