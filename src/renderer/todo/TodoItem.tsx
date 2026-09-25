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
        className="mt-auto border-t border-white/6 pt-3 text-[12px] text-dim"
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
        'flex origin-top animate-unfold flex-col gap-2.5 overflow-hidden rounded-xl border border-white/6 bg-surface p-3 motion-reduce:animate-none',
        todo.kind === 'answer' && 'border-waiting/30 bg-waiting/6',
        todo.kind === 'rate-limit' && 'border-destructive/30 bg-destructive/6',
      )}
    >
      <span className="font-mono text-[12px] leading-[1.5] break-words text-foreground">
        {what}
      </span>
      {who !== undefined && (
        <span className="order-first flex items-center gap-2 text-[12px] text-[#a1a1aa]">
          {separator}
          <span aria-hidden className="size-[7px] flex-none rounded-full bg-(--agent-color)" />
          <span className="min-w-0 truncate">{who}</span>
        </span>
      )}
      {hints.length > 0 && (
        <span className="text-[12px] text-dim">
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
