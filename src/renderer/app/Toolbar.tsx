import styles from './shell.module.css';

type Props = { todoCount: number; onAddAgents: () => void };

/** Workspace views; Comparer and Revue stay visible but inactive in the core (FR-006). */
export function Toolbar({ todoCount, onAddAgents }: Props) {
  return (
    <nav role="toolbar" aria-label="Vues" className={styles.toolbar}>
      <button className={styles.viewButton} aria-pressed>
        Tuiles
      </button>
      <button className={styles.viewButton} disabled>
        Comparer
      </button>
      <button className={styles.viewButton} disabled>
        Revue
      </button>
      <span className={styles.spacer} />
      <button className={styles.viewButton}>
        À faire <span className={styles.count}>{todoCount}</span>
      </button>
      <button className={styles.primary} onClick={onAddAgents}>
        + Agents
      </button>
    </nav>
  );
}
