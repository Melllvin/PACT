import { useState } from 'react';
import { MAX_AGENTS, type CliDefinition, type Workspace } from '../../shared/model';
import type { LaunchCounts } from '../store/app-store';
import styles from './launch.module.css';
import { useDialogKeys } from './use-dialog-keys';

export type QuickLaunchProps = {
  clis: CliDefinition[];
  /** Counters last used in this workspace (FR-010). */
  counters: Workspace['quickLaunchCounters'];
  /** Agents already in the workspace, counted against the limit of six. */
  existingAgents: number;
  error: string | null;
  onLaunch: (counts: LaunchCounts) => void;
  onClose: () => void;
};

const MAX_FREE_TERMINALS = 6;

const agentsLabel = (count: number) => `Lancer ${String(count)} agent${count > 1 ? 's' : ''}`;
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

/** Screen 1c — mode rapide: how many agents of each CLI, and free terminals (FR-009, FR-010). */
export function QuickLaunch({
  clis,
  counters,
  existingAgents,
  error,
  onLaunch,
  onClose,
}: QuickLaunchProps) {
  const installed = clis.filter((cli) => cli.status === 'installed');
  const detected = installed.filter((cli) => cli.origin === 'detected');
  // « Autre CLI… » launches the first CLI added by hand.
  const other = installed.find((cli) => cli.origin === 'custom');
  const firstLaunch = Object.keys(counters).every((key) => key === 'freeTerminal');

  const [agents, setAgents] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      [...detected, ...(other ? [other] : [])].map((cli, index) => [
        cli.id,
        counters[cli.id] ?? (firstLaunch && index === 0 ? 1 : 0),
      ]),
    ),
  );
  const [freeTerminal, setFreeTerminal] = useState(counters.freeTerminal);

  const total = Object.values(agents).reduce((sum, count) => sum + count, 0);
  const full = existingAgents + total >= MAX_AGENTS;
  const label = total === 0 && freeTerminal > 0 ? terminalsLabel(freeTerminal) : agentsLabel(total);

  const launch = () => {
    if (total === 0 && freeTerminal === 0) return;
    onLaunch({
      agents: Object.fromEntries(Object.entries(agents).filter(([, count]) => count > 0)),
      freeTerminal,
    });
  };
  useDialogKeys({ onEscape: onClose });

  const counter = (cli: CliDefinition, name = cli.name) => (
    <Counter
      key={cli.id}
      label={name}
      value={agents[cli.id] ?? 0}
      canAdd={!full}
      onChange={(value) => {
        setAgents({ ...agents, [cli.id]: value });
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
        onChange={setFreeTerminal}
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
