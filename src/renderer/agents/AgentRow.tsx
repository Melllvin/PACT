import type { CSSProperties } from 'react';
import { ROLE_LABELS, type AgentRow as Row } from '../../shared/agents-view';
import { TodoActions } from '../todo/TodoItem';
import type { AgentActions } from '../workspace/WorkspaceView';

type Props = Omit<AgentActions, 'onClose'> & {
  row: Row;
  /** #46 — the color of the agent among its workspace's. */
  color?: string;
  onOpen: (agentId: string) => void;
};

const SEPARATOR = ' · ';

/**
 * One agent of the column: the main button opens it; the buttons of its request, when it has one,
 * sit beside it, never inside (contracts/ui.md).
 */
export function AgentRow({ row, color, onOpen, ...actions }: Props) {
  const { agent, todo } = row;
  const label = [
    row.name,
    ...(row.role ? [ROLE_LABELS[row.role]] : []),
    row.stateLabel,
    ...(row.issueId ? [`issue ${row.issueId}`] : []),
  ].join(', ');
  const [what, , ...hints] = todo?.title.split(SEPARATOR) ?? [];
  return (
    <li
      style={{ '--agent-color': color ?? `var(--agent-${agent.color})` } as CSSProperties}
      className="flex flex-col gap-2 rounded-xl border border-white/6 bg-surface p-3"
    >
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          onOpen(agent.id);
        }}
        className="block min-w-0 truncate rounded-md text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span
          aria-hidden
          className="mr-2 inline-block size-[7px] rounded-full bg-(--agent-color)"
        />
        <span>{row.name}</span>
        {row.role && (
          <>
            {' '}
            <span className="ml-2 font-mono text-[11px] text-[#a1a1aa]">
              {ROLE_LABELS[row.role]}
            </span>
          </>
        )}{' '}
        <span className="ml-2 text-[12px] text-[#a1a1aa]">{row.stateLabel}</span>
        {row.issueId && (
          <>
            {' '}
            <span className="ml-2 font-mono text-[11px] text-[#a1a1aa]">issue {row.issueId}</span>
          </>
        )}
      </button>
      {todo && (
        <>
          <span className="font-mono text-[12px] leading-[1.5] break-words text-foreground">
            {what}
          </span>
          {hints.length > 0 && (
            <span className="text-[12px] text-[#a1a1aa]">{hints.join(SEPARATOR)}</span>
          )}
          <TodoActions todo={todo} agent={agent} {...actions} />
        </>
      )}
    </li>
  );
}
