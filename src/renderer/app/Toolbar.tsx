import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

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
      <ToggleGroup
        type="single"
        value="tiles"
        aria-label="Vue"
        variant="segment"
        className="rounded-[10px] border border-white/6 bg-white/3 p-[3px]"
      >
        <ToggleGroupItem value="tiles" className="w-[78px]">
          Tuiles
        </ToggleGroupItem>
        <ToggleGroupItem value="compare" className="w-[78px]" disabled>
          Comparer
        </ToggleGroupItem>
        <ToggleGroupItem value="review" className="w-[78px]" disabled>
          Revue
        </ToggleGroupItem>
      </ToggleGroup>
      {showTodo && (
        <Toggle pressed={todoOpen} onPressedChange={() => onToggleTodo?.()}>
          À faire <Badge variant={todoCount > 0 ? 'waiting' : 'muted'}>{todoCount}</Badge>
        </Toggle>
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
