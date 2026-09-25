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
  'flex h-[26px] w-[78px] cursor-pointer items-center justify-center rounded-[7px] text-[12.5px] text-muted-foreground transition-[background-color,color] duration-300 disabled:cursor-default disabled:text-[#4a4a52] aria-pressed:bg-white/8 aria-pressed:text-foreground';

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
      <span className="flex rounded-[10px] border border-white/6 bg-white/3 p-[3px]">
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
          className="flex h-8 flex-none cursor-pointer items-center gap-2 rounded-[9px] border border-white/7 px-3 text-[12.5px] whitespace-nowrap transition-[background-color,border-color] duration-250 hover:border-white/14 aria-pressed:bg-white/5"
          aria-pressed={todoOpen}
          onClick={onToggleTodo}
        >
          À faire{' '}
          <span
            className={cn(
              'flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] px-[5px] font-mono text-[10.5px] font-medium transition-[background-color] duration-300',
              todoCount > 0 ? 'bg-waiting text-[#1a1206]' : 'bg-white/10 text-[#a1a1aa]',
            )}
          >
            {todoCount}
          </span>
        </button>
      )}
      <Button
        variant="contrast"
        size="md"
        className="h-8 rounded-[9px] px-3 text-[12.5px]"
        onClick={onAddAgents}
        disabled={!onAddAgents}
      >
        + Agents
      </Button>
    </nav>
  );
}
