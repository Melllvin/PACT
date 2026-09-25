import type { CSSProperties } from 'react';
import type { Agent, TodoItem as Todo } from '../../shared/model';
import { TileActions } from '../tiles/TileActions';
import type { AgentActions } from '../workspace/WorkspaceView';
import { cn } from '@/lib/utils';

type Props = Omit<AgentActions, 'onClose'> & {
  todo: Todo;
  /** Absent for a free terminal, which has no color nor actions. */
  agent: Agent | undefined;
};

const SEPARATOR = ' · ';

/**
 * One request, in the color of its agent, with the same buttons as its tile (FR-028). Its title
 * reads « what · who · hint »: 1f shows who above, with the agent's dot, and the hint below.
 */
export function TodoItem({
  todo,
  agent,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onCancelAutoResume,
}: Props) {
  const style = agent && ({ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties);
  const [what, who, ...hints] = todo.title.split(SEPARATOR);
  const separator = <span className="sr-only">{SEPARATOR}</span>;

  if (todo.kind === 'info') {
    return (
      <li
        data-kind={todo.kind}
        style={style}
        className="mt-auto border-t border-border pt-2.5 text-[11.5px] text-muted-foreground"
      >
        {todo.title}
      </li>
    );
  }
  return (
    <li
      data-kind={todo.kind}
      style={style}
      className={cn(
        'flex origin-top animate-unfold flex-col gap-1.5 overflow-hidden rounded-md border border-border bg-[#131820] px-2.5 py-[9px] motion-reduce:animate-none',
        todo.kind === 'answer' && 'border-[1.5px] border-waiting bg-[rgb(214_147_79/10%)]',
      )}
    >
      <span className="text-[12.5px] font-semibold text-foreground">{what}</span>
      {who !== undefined && (
        <span className="order-first flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {separator}
          <span aria-hidden className="size-2 flex-none rounded-full bg-(--agent-color)" />
          <span>{who}</span>
        </span>
      )}
      {hints.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          {separator}
          <span>{hints.join(SEPARATOR)}</span>
        </span>
      )}
      {agent && (
        <TileActions
          state={agent.state}
          scheduledResume={agent.scheduledResume}
          onAnswer={(answer) => {
            onAnswer(agent.id, answer);
          }}
          onResume={() => {
            onResume(agent.id);
          }}
          onRestart={() => {
            onRestart(agent.id);
          }}
          onLog={() => {
            onLog(agent.id);
          }}
          onCancelAutoResume={() => {
            onCancelAutoResume(agent.id);
          }}
        />
      )}
    </li>
  );
}
