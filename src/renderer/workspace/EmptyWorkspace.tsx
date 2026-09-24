import styles from './workspace.module.css';

/** Screen 1b: empty on purpose, one action that opens the same launcher as « + Agents ». */
export function EmptyWorkspace({ onAddAgents }: { onAddAgents?: (() => void) | undefined }) {
  return (
    <div className={styles.empty}>
      <button className={styles.add} onClick={onAddAgents} disabled={!onAddAgents}>
        <span aria-hidden className={styles.plus}>
          +
        </span>
        Ajouter des agents
      </button>
    </div>
  );
}
