import {
  EFFORTS,
  ROLES,
  type CliDefinition,
  type Effort,
  type Role,
  type RoleProfile,
} from '../../shared/model';
import { ROLE_LABELS, profileWarnings, profilesOf } from '../../shared/roles';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

// 004 US1 — the role profiles of a workspace: CLI, model, effort and ceiling of each role, the
// defaults until the user changes one (FR-002 to FR-004).

type Stored = Partial<Record<Role, RoleProfile>>;

type Props = {
  clis: CliDefinition[];
  /** Only what the user set; the other roles take their default profile. */
  stored: Stored;
  onChange: (profiles: Stored) => void;
};

const CONTROL =
  'w-full min-w-0 rounded-[10px] border border-white/8 bg-white/2 px-[9px] py-1.5 text-[12.5px] text-foreground disabled:opacity-50';

export function RoleProfiles({ clis, stored, onChange }: Props) {
  const profiles = profilesOf(stored, clis);
  const warnings = profileWarnings(profiles, clis);
  const installed = clis.filter((cli) => cli.status === 'installed');

  const set = (role: Role, change: Partial<RoleProfile>) => {
    const current = profiles[role];
    if (!current) return;
    onChange({ ...stored, [role]: { ...current, ...change } });
  };
  const reset = (role: Role) => {
    onChange(Object.fromEntries(Object.entries(stored).filter(([name]) => name !== role)));
  };

  return (
    <div className="flex flex-col gap-3">
      <table className="w-full border-separate border-spacing-x-2 border-spacing-y-1.5 text-[12.5px]">
        <thead className="text-left text-[11px] text-muted-foreground">
          <tr>
            <th scope="col">Rôle</th>
            <th scope="col">CLI</th>
            <th scope="col">Modèle</th>
            <th scope="col">Effort</th>
            <th scope="col">Plafond</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => {
            const label = ROLE_LABELS[role];
            const profile = profiles[role];
            const cli = clis.find((c) => c.id === profile?.cliId);
            const missing = profile !== undefined && cli?.status !== 'installed';
            const models = cli?.models ?? [];
            const control = (field: string) => `${field} · ${label}`;
            return (
              <tr key={role} aria-label={label}>
                <th scope="row" className="text-left font-medium">
                  {label}
                </th>
                {profile ? (
                  <>
                    <td>
                      <select
                        aria-label={control('CLI')}
                        className={CONTROL}
                        value={profile.cliId}
                        onChange={(event) => {
                          // Another CLI does not keep the models of the previous one.
                          set(role, { cliId: event.target.value, model: null, maxModel: null });
                        }}
                      >
                        {missing && (
                          <option value={profile.cliId}>{cli?.name ?? profile.cliId}</option>
                        )}
                        {installed.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={control('Modèle')}
                        className={CONTROL}
                        value={profile.model ?? ''}
                        onChange={(event) => {
                          set(role, { model: event.target.value || null });
                        }}
                      >
                        <option value="">Par défaut du CLI</option>
                        {models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={control('Effort')}
                        className={CONTROL}
                        value={profile.effort ?? ''}
                        disabled={cli?.supportsEffort !== true}
                        onChange={(event) => {
                          const effort: Effort | null =
                            EFFORTS.find((e) => e === event.target.value) ?? null;
                          set(role, { effort });
                        }}
                      >
                        <option value="">Par défaut</option>
                        {EFFORTS.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={control('Plafond')}
                        className={CONTROL}
                        value={profile.maxModel ?? ''}
                        onChange={(event) => {
                          set(role, { maxModel: event.target.value || null });
                        }}
                      >
                        <option value="">Aucun</option>
                        {models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </td>
                    {missing && (
                      <td className="text-[11.5px] text-destructive">
                        {`${cli?.name ?? profile.cliId} n’est pas installé`}
                        <Button
                          className="ml-2"
                          onClick={() => {
                            reset(role);
                          }}
                        >
                          Revenir au profil par défaut
                        </Button>
                      </td>
                    )}
                  </>
                ) : (
                  <td colSpan={4} className="text-muted-foreground">
                    Aucun CLI installé
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {warnings.length > 0 && (
        <p role="status" className="m-0 text-[12px] text-amber-300">
          {warnings.join(' ')}
        </p>
      )}
    </div>
  );
}

/** « Rôles » of the workspace bar: the profiles in a dialog, saved as they change. */
export function RoleProfilesDialog({ onClose, ...props }: Props & { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[min(720px,calc(100vw-32px))]">
        <DialogBody className="gap-3 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Profils de rôle
          </DialogTitle>
          <RoleProfiles {...props} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
