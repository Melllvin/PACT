import type { AgentState, ScheduledResume } from '../../shared/model';
import styles from './tiles.module.css';

export type TileActionHandlers = {
  onAnswer: (answer: 'allow' | 'deny') => void;
  onResume: () => void;
  onRestart: () => void;
  onLog: () => void;
  /** « Annuler » of « reprise auto à HH:MM » (FR-036). */
  onCancelAutoResume: () => void;
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
  onCancelAutoResume,
  onAlways,
  scheduledResume = null,
}: TileActionHandlers & { state: AgentState; scheduledResume?: ScheduledResume | null }) {
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
        {scheduledResume && (
          <>
            <span className={styles.scheduled}>reprise auto à {resumeTime(scheduledResume)}</span>
            <button onClick={onCancelAutoResume}>Annuler</button>
          </>
        )}
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

/** HH:MM in the local time zone, as the rate limit banners of the CLIs give it. */
function resumeTime({ at }: ScheduledResume) {
  return new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
