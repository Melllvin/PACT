import type { AgentState } from '../../shared/model';
import styles from './tiles.module.css';

export type TileActionHandlers = {
  onAnswer: (answer: 'allow' | 'deny') => void;
  onResume: () => void;
  onRestart: () => void;
  onLog: () => void;
  /** « Toujours pour ce worktree », offered in the Focus only (FR-034). */
  onAlways?: (() => void) | undefined;
};

/** Bottom right of a tile, by state (FR-024): answer a question, or recover from an error. */
export function TileActions({
  state,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onAlways,
}: TileActionHandlers & { state: AgentState }) {
  if (state === 'awaiting-answer') {
    return (
      <span className={styles.actions}>
        {onAlways && <button onClick={onAlways}>Toujours pour ce worktree</button>}
        <button
          className={styles.deny}
          onClick={() => {
            onAnswer('deny');
          }}
        >
          ✕ Refuser
        </button>
        <button
          className={styles.allow}
          onClick={() => {
            onAnswer('allow');
          }}
        >
          ✓ Autoriser
        </button>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className={styles.actions}>
        <button onClick={onLog}>Journal</button>
        <button onClick={onRestart}>Relancer</button>
        <button className={styles.allow} onClick={onResume}>
          Reprendre
        </button>
      </span>
    );
  }
  return null;
}
