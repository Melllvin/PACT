import type { Agent, TodoItem as Todo } from '../../shared/model';
import type { AgentActions } from '../workspace/WorkspaceView';
import { TodoItem } from './TodoItem';

type Props = Omit<AgentActions, 'onClose'> & {
  todos: Todo[];
  agents: Agent[];
};

/** The À faire column (screens 1f, 1l): what the agents need, answers first (FR-027). */
export function TodoColumn({ todos, agents, ...actions }: Props) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  // « En cours » only informs: the count is of what waits on the user.
  const waiting = todos.filter((todo) => todo.kind !== 'info').length;
  return (
    <aside
      aria-label="À faire"
      className="relative z-10 flex w-[300px] flex-none flex-col gap-2.5 overflow-y-auto border-l border-white/6 bg-background px-4 py-[18px]"
    >
      <h2 className="m-0 flex items-baseline gap-2 px-0.5 pb-1.5 text-[15px] font-medium tracking-[-0.01em]">
        À faire <span className="font-mono text-[11px] font-normal text-dim">{waiting}</span>
      </h2>
      {todos.length === 0 ? (
        <p className="m-0 px-2 py-7 text-center text-[13px] text-[#a1a1aa]">
          Rien à faire · vous serez prévenu
        </p>
      ) : (
        <ul aria-label="À faire" className="m-0 flex flex-1 list-none flex-col gap-2.5 p-0">
          {todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} agent={byId.get(todo.agentId)} {...actions} />
          ))}
        </ul>
      )}
    </aside>
  );
}
