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
import { LocalChangesNotice } from './LocalChangesNotice';
import { agentsLabel } from './QuickLaunch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';

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
  /** The repository has uncommitted changes, left out of the worktrees (T122). */
  localChanges?: boolean;
  onLaunch: () => void;
  onQuick: () => void;
  onClose: () => void;
};

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
  localChanges = false,
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

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        aria-describedby={undefined}
        className="h-[min(500px,calc(100vh-48px))] w-[min(800px,calc(100vw-32px))]"
      >
        <header className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <DialogTitle className="font-sans text-[15px] font-semibold tracking-normal text-foreground normal-case">
            Lancer des agents
          </DialogTitle>
          <Button variant="link" size="md" onClick={onQuick}>
            ← Mode rapide
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)]">
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
            running={running}
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

        {localChanges && <LocalChangesNotice className="mx-4 mb-2" />}
        {(found.length > 0 || error) && (
          <div className="flex flex-col gap-1 border-t border-white/8 px-4 py-2">
            {found.map((conflict) => (
              <p
                key={`${String(conflict.index)}-${conflict.kind}`}
                role="alert"
                className="m-0 text-[12.5px] text-destructive"
              >
                {conflictText(conflict)}
              </p>
            ))}
            {error && (
              <p role="alert" className="m-0 text-[12.5px] text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="py-2.5">
          <span className="flex-1 font-mono text-[10.5px] text-dim">
            ≠ diffère du commun · pointillés = hérité
          </span>
          <Button size="md" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="contrast"
            size="md"
            disabled={found.length > 0 || (total === 0 && draft.freeTerminal === 0)}
            onClick={onLaunch}
          >
            {agentsLabel(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
