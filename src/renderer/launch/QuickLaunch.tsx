import { countsOf, withCount, type LaunchDraft } from '../../shared/launch-draft';
import { MAX_AGENTS, type CliDefinition } from '../../shared/model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type QuickLaunchProps = {
  clis: CliDefinition[];
  /** Shared with the detailed mode: counters only add or remove agents (FR-011). */
  draft: LaunchDraft;
  onChange: (draft: LaunchDraft) => void;
  /** Agents already in the workspace, counted against the limit of six. */
  existingAgents: number;
  error: string | null;
  onLaunch: () => void;
  onDetailed: () => void;
  onClose: () => void;
};

const MAX_FREE_TERMINALS = 6;
const OTHER_HINT = 'aider, gemini…';

export const agentsLabel = (count: number) =>
  `Lancer ${String(count)} agent${count > 1 ? 's' : ''}`;
const terminalsLabel = (count: number) =>
  `Ouvrir ${String(count)} ${count > 1 ? 'terminaux' : 'terminal'}`;

type CounterProps = {
  label: string;
  /** What the row launches, under its name (1c). */
  hint?: string | undefined;
  value: number;
  canAdd: boolean;
  onChange: (value: number) => void;
};

const STEP =
  'h-6 w-[26px] cursor-pointer text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-45';

function Counter({ label, hint, value, canAdd, onChange }: CounterProps) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2.5">
      <span className="flex flex-1 flex-col gap-px">
        <span className={cn('text-[13.5px] font-semibold', value === 0 && 'text-muted-foreground')}>
          {label}
        </span>
        {hint && <span className="font-mono text-[10.5px] text-[#5c6574]">{hint}</span>}
      </span>
      <span className="flex items-center rounded-[5px] border border-border font-mono text-[12px]">
        <button
          type="button"
          className={STEP}
          onClick={() => {
            onChange(value - 1);
          }}
          disabled={value === 0}
        >
          −
        </button>
        <span
          role="status"
          className={cn(
            'w-6 border-x border-border py-[3px] text-center',
            value === 0 && 'text-[#5c6574]',
          )}
        >
          {value}
        </span>
        <button
          type="button"
          className={STEP}
          onClick={() => {
            onChange(value + 1);
          }}
          disabled={!canAdd}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** The CLIs the quick mode counts: the detected ones, and the first one added by hand. */
export function launchableClis(clis: CliDefinition[]) {
  const installed = clis.filter((cli) => cli.status === 'installed');
  return {
    detected: installed.filter((cli) => cli.origin === 'detected'),
    // « Autre CLI… » launches the first CLI added by hand.
    other: installed.find((cli) => cli.origin === 'custom'),
  };
}

/** Screen 1c — mode rapide: how many agents of each CLI, and free terminals (FR-009, FR-010). */
export function QuickLaunch({
  clis,
  draft,
  onChange,
  existingAgents,
  error,
  onLaunch,
  onDetailed,
  onClose,
}: QuickLaunchProps) {
  const { detected, other } = launchableClis(clis);
  const { agents, freeTerminal } = countsOf(draft);

  const total = draft.agents.length;
  const full = existingAgents + total >= MAX_AGENTS;
  const label = total === 0 && freeTerminal > 0 ? terminalsLabel(freeTerminal) : agentsLabel(total);

  const counter = (cli: CliDefinition, name = cli.name, hint?: string) => (
    <Counter
      key={cli.id}
      label={name}
      hint={hint}
      value={agents[cli.id] ?? 0}
      canAdd={!full}
      onChange={(value) => {
        onChange(withCount(draft, cli.id, value));
      }}
    />
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>Ajouter au workspace</DialogTitle>
          {detected.length === 0 && (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              Aucun CLI d’agent détecté. Installez Claude Code ou Codex, puis détectez-les à nouveau
              depuis l’accueil.
            </p>
          )}
          {detected.map((cli) => counter(cli))}
          {other ? (
            counter(other, 'Autre CLI…', OTHER_HINT)
          ) : (
            <Counter
              label="Autre CLI…"
              hint={OTHER_HINT}
              value={0}
              canAdd={false}
              // Both buttons stay disabled until a CLI is added: nothing ever changes this counter.
              /* v8 ignore start */
              onChange={() => undefined}
              /* v8 ignore stop */
            />
          )}
          <Counter
            label="Terminal libre"
            hint="dépôt principal"
            value={freeTerminal}
            canAdd={freeTerminal < MAX_FREE_TERMINALS}
            onChange={(value) => {
              onChange({ ...draft, freeTerminal: value });
            }}
          />
          {full && (
            <p className="m-0 text-[12px] text-muted-foreground">
              {MAX_AGENTS} agents au plus par workspace.
            </p>
          )}
          <div className="h-px bg-border" />
          <label className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
            <span className="flex-1">Workflow</span>
            <select
              defaultValue="free"
              className="rounded-[5px] border border-border bg-[#0a0d12] px-2.5 py-1.5 text-[12.5px] text-muted-foreground"
            >
              <option value="free">Libre</option>
            </select>
          </label>
          {error && (
            <p
              role="alert"
              className="m-0 rounded-[5px] border border-destructive px-2.5 py-2 text-[12.5px]"
            >
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="link" size="md" onClick={onDetailed}>
            Mode détaillé…
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" size="md" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={total === 0 && freeTerminal === 0}
            onClick={onLaunch}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
