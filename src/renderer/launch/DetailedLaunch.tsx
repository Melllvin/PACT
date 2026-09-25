import { useState } from 'react';
import {
  conflicts,
  duplicate,
  remove,
  withCount,
  type Conflict,
  type LaunchDraft,
} from '../../shared/launch-draft';
import { MAX_AGENTS, type Agent, type CliDefinition } from '../../shared/model';
import { AgentInspector } from './AgentInspector';
import { AgentList, type Selection } from './AgentList';
import { agentsLabel } from './QuickLaunch';
import { useDialogKeys } from './use-dialog-keys';

export type DetailedLaunchProps = {
  clis: CliDefinition[];
  draft: LaunchDraft;
  onChange: (draft: LaunchDraft) => void;
  /** Agents of this workspace: the limit of six, and where new tiles land. */
  running: Pick<Agent, 'position' | 'color'>[];
  /** Agents of every workspace: their branches and ports are taken. */
  taken: Pick<Agent, 'branch' | 'port'>[];
  /** Why main refused the launch (LIMIT, BRANCH_CONFLICT, PORT_CONFLICT). */
  error: string | null;
  onLaunch: () => void;
  onQuick: () => void;
  onClose: () => void;
};

const BUTTON = 'cursor-pointer rounded-sm border border-border px-2.5 py-1 text-sm';

const conflictText = ({ index, kind, value }: Conflict) =>
  kind === 'branch'
    ? `Agent ${String(index + 1)} : la branche « ${String(value)} » est déjà prise.`
    : `Agent ${String(index + 1)} : le port ${String(value)} est déjà pris.`;

/** Screen 1d — mode détaillé: the list on the left, the inspector on the right (FR-011). */
export function DetailedLaunch({
  clis,
  draft,
  onChange,
  running,
  taken,
  error,
  onLaunch,
  onQuick,
  onClose,
}: DetailedLaunchProps) {
  const installed = clis.filter((cli) => cli.status === 'installed');
  const [selected, setSelected] = useState<Selection>('common');
  const index = draft.agents.findIndex((agent) => agent.key === selected);
  const found = conflicts(draft, taken);
  const total = draft.agents.length;
  const first = installed[0];
  const canAdd = first !== undefined && running.length + total < MAX_AGENTS;
  const cliName = (cliId: string) => clis.find((cli) => cli.id === cliId)?.name ?? cliId;
  useDialogKeys({ onEscape: onClose });

  return (
    <div
      role="dialog"
      aria-label="Lancer des agents"
      className="fixed top-16 left-1/2 z-10 grid max-h-[calc(100vh-96px)] w-[min(880px,calc(100vw-32px))] -translate-x-1/2 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 rounded-md border border-border bg-card p-4 shadow-[0_12px_32px_rgb(0_0_0/45%)]"
    >
      <header className="flex items-center gap-3">
        <h2 className="flex-1 text-lg">Lancer des agents</h2>
        <button className={BUTTON} onClick={onQuick}>
          ← Mode rapide
        </button>
      </header>

      <div className="grid min-h-0 grid-cols-[260px_1fr] gap-4">
        <AgentList
          draft={draft}
          onChange={onChange}
          running={running}
          cliName={cliName}
          selected={index === -1 ? 'common' : selected}
          onSelect={setSelected}
          canAdd={canAdd}
          onAdd={() => {
            if (!first) return;
            const count = draft.agents.filter((agent) => agent.cliId === first.id).length;
            onChange(withCount(draft, first.id, count + 1));
          }}
        />
        <AgentInspector
          draft={draft}
          onChange={onChange}
          clis={installed}
          index={index === -1 ? null : index}
          onDuplicate={() => {
            onChange(duplicate(draft, index));
          }}
          onRemove={() => {
            onChange(remove(draft, index));
            setSelected('common');
          }}
        />
      </div>

      <footer className="flex flex-col gap-2">
        {found.map((conflict) => (
          <p
            key={`${String(conflict.index)}-${conflict.kind}`}
            role="alert"
            className="text-sm text-destructive"
          >
            {conflictText(conflict)}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground">
            ≠ diffère du commun · pointillés = hérité
          </span>
          <button className={BUTTON} onClick={onClose}>
            Annuler
          </button>
          <button
            className={`${BUTTON} border-primary bg-primary text-primary-foreground disabled:opacity-40`}
            disabled={found.length > 0 || (total === 0 && draft.freeTerminal === 0)}
            onClick={onLaunch}
          >
            {agentsLabel(total)}
          </button>
        </div>
      </footer>
    </div>
  );
}
