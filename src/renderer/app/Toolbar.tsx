import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Without `onAddAgents`, « + Agents » stays disabled rather than doing nothing; `showTodo` is off
 * until the first agent exists (FR-006).
 */
type Props = {
  todoCount: number;
  showTodo?: boolean;
  /** Whether the À faire column is shown; closed, the button keeps the count (US4). */
  todoOpen?: boolean;
  onToggleTodo?: () => void;
  onAddAgents?: (() => void) | undefined;
};

const VIEW =
  'flex items-center gap-[5px] px-[11px] py-1 not-first:border-l not-first:border-border disabled:text-[#5c6574] aria-pressed:bg-primary aria-pressed:text-primary-foreground';

/** Workspace views; Comparer and Revue stay visible but inactive in the core (FR-006). */
export function Toolbar({
  todoCount,
  showTodo = true,
  todoOpen = false,
  onToggleTodo,
  onAddAgents,
}: Props) {
  return (
    <nav role="toolbar" aria-label="Vues" className="flex items-center gap-2">
      <span className="flex overflow-hidden rounded-md border border-border text-[12px] font-medium">
        <button className={VIEW} aria-pressed>
          Tuiles
        </button>
        <button className={VIEW} disabled>
          Comparer
        </button>
        <button className={VIEW} disabled>
          Revue
        </button>
      </span>
      {showTodo && (
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium aria-pressed:bg-card"
          aria-pressed={todoOpen}
          onClick={onToggleTodo}
        >
          À faire{' '}
          <span
            className={cn(
              'rounded-[3px] px-[5px] font-mono text-[10.5px]',
              todoCount > 0 ? 'bg-waiting text-[#17100a]' : 'text-muted-foreground',
            )}
          >
            {todoCount}
          </span>
        </button>
      )}
      <Button variant="primary" onClick={onAddAgents} disabled={!onAddAgents}>
        + Agents
      </Button>
    </nav>
  );
}
