import { countsOf, withCount, type LaunchDraft } from '../../shared/launch-draft';
import { MAX_AGENTS, type CliDefinition } from '../../shared/model';
import styles from './launch.module.css';
import { useDialogKeys } from './use-dialog-keys';

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

export const agentsLabel = (count: number) =>
  `Lancer ${String(count)} agent${count > 1 ? 's' : ''}`;
const terminalsLabel = (count: number) =>
  `Ouvrir ${String(count)} terminal${count > 1 ? 'aux' : ''}`;

type CounterProps = {
  label: string;
  value: number;
  canAdd: boolean;
  onChange: (value: number) => void;
};

function Counter({ label, value, canAdd, onChange }: CounterProps) {
  return (
    <div role="group" aria-label={label} className={styles.row}>
      <span className={styles.rowName}>{label}</span>
      <button
        onClick={() => {
          onChange(value - 1);
        }}
        disabled={value === 0}
      >
        −
      </button>
      <span role="status" className={styles.count}>
        {value}
      </span>
      <button
        onClick={() => {
          onChange(value + 1);
        }}
        disabled={!canAdd}
      >
        +
      </button>
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

  const launch = () => {
    if (total === 0 && freeTerminal === 0) return;
    onLaunch();
  };
  useDialogKeys({ onEscape: onClose });

  const counter = (cli: CliDefinition, name = cli.name) => (
    <Counter
      key={cli.id}
      label={name}
      value={agents[cli.id] ?? 0}
      canAdd={!full}
      onChange={(value) => {
        onChange(withCount(draft, cli.id, value));
      }}
    />
  );

  return (
    <div role="dialog" aria-label="Ajouter au workspace" className={styles.dialog}>
      <h2>Ajouter au workspace</h2>
      {detected.length === 0 && (
        <p className={styles.hint}>
          Aucun CLI d’agent détecté. Installez Claude Code ou Codex, puis détectez-les à nouveau
          depuis l’accueil.
        </p>
      )}
      {detected.map((cli) => counter(cli))}
      {other ? (
        counter(other, 'Autre CLI…')
      ) : (
        <Counter label="Autre CLI…" value={0} canAdd={false} onChange={() => undefined} />
      )}
      <Counter
        label="Terminal libre"
        value={freeTerminal}
        canAdd={freeTerminal < MAX_FREE_TERMINALS}
        onChange={(value) => {
          onChange({ ...draft, freeTerminal: value });
        }}
      />
      {full && <p className={styles.hint}>{MAX_AGENTS} agents au plus par workspace.</p>}
      <label className={styles.field}>
        Workflow
        <select defaultValue="free">
          <option value="free">Libre</option>
        </select>
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button onClick={onDetailed}>Mode détaillé…</button>
        <span className={styles.spacer} />
        <button onClick={onClose}>Annuler</button>
        <button
          className={styles.primary}
          disabled={total === 0 && freeTerminal === 0}
          onClick={launch}
        >
          {label}
        </button>
      </div>
    </div>
  );
}
