import styles from './shell.module.css';

/**
 * Without `onAddAgents`, « + Agents » stays disabled rather than doing nothing; `showTodo` is off
 * until the first agent exists (FR-006).
 */
type Props = {
  todoCount: number;
  showTodo?: boolean;
  onAddAgents?: (() => void) | undefined;
};

/** Workspace views; Comparer and Revue stay visible but inactive in the core (FR-006). */
export function Toolbar({ todoCount, showTodo = true, onAddAgents }: Props) {
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
      {showTodo && (
        <button className={styles.viewButton}>
          À faire <span className={styles.count}>{todoCount}</span>
        </button>
      )}
      <button className={styles.primary} onClick={onAddAgents} disabled={!onAddAgents}>
        + Agents
      </button>
    </nav>
  );
}
