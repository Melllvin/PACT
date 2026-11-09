import { deliverySettingsSchema, type DeliverySettings } from '../../shared/delivery';
import { IpcFailure, type IpcInput } from '../../shared/ipc';
import type { Workspace } from '../../shared/model';
import type { DeliveryService } from '../delivery/delivery-service';

// 008 contracts/ui.md — `delivery:settings`: the settings of the delivery of a project (FR-019, FR-020),
// saved in the workspace; the delivery is told once they are written (FR-011).

type Dependencies = {
  workspaces: {
    get(id: string): Workspace | undefined;
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
  delivery: Pick<DeliveryService, 'settingsChanged'>;
  /** `workspace:deliveries` to the renderer. */
  onChange?: (
    workspaceId: string,
    change: { deliveries: Workspace['deliveries']; delivery: DeliverySettings },
  ) => void;
};

export function createDeliveryServices({ workspaces, delivery, onChange }: Dependencies) {
  return {
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
