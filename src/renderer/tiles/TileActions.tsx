import type { AgentState, ScheduledResume } from '../../shared/model';
import { Button } from '@/components/ui/button';

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

const GROUP = 'flex flex-none flex-wrap items-center justify-end gap-1.5';

/**
 * Bottom right of a tile, by state (FR-024): answer a question, or recover from an error. Solid
 * green and red to answer, cyan to resume (1f, 1n).
 */
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
      <span className={GROUP}>
        {onAlways && <Button onClick={onAlways}>Toujours pour ce worktree</Button>}
        <Button
          variant="danger"
          onClick={() => {
            onAnswer('deny');
          }}
        >
          ✕ Refuser
        </Button>
        <Button
          variant="accept"
          onClick={() => {
            onAnswer('allow');
          }}
        >
          ✓ Autoriser
        </Button>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className={GROUP}>
        {scheduledResume && (
          <>
            <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
              reprise auto à {resumeTime(scheduledResume)}
            </span>
            <Button variant="link" onClick={onCancelAutoResume}>
              Annuler
            </Button>
          </>
        )}
        <Button onClick={onLog}>Journal</Button>
        <Button onClick={onRestart}>Relancer</Button>
        <Button variant="primary" onClick={onResume}>
          Reprendre
        </Button>
      </span>
    );
  }
  return null;
}

/** HH:MM in the local time zone, as the rate limit banners of the CLIs give it. */
function resumeTime({ at }: ScheduledResume) {
  return new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
