import { agentColor } from '../../shared/agent-color';
import type { AgentsView } from '../../shared/agents-view';
import { TodoItem } from '../todo/TodoItem';
import type { AgentActions } from '../workspace/WorkspaceView';
import { AgentRow } from './AgentRow';

type Props = Omit<AgentActions, 'onClose'> & {
  view: AgentsView;
  onOpen: (agentId: string) => void;
};

/** The Agents column (contracts/ui.md): what waits on the user, then one row per agent. */
export function AgentsColumn({ view, onOpen, ...actions }: Props) {
  const all = view.rows.map((row) => row.agent);
  const byId = new Map(all.map((agent) => [agent.id, agent]));
  return (
    <aside
      aria-label="Agents"
      className="relative z-10 flex w-[300px] flex-none flex-col gap-2.5 overflow-y-auto border-l border-white/6 bg-background px-4 pb-[18px]"
    >
      <h2 className="sticky top-0 z-10 m-0 flex items-baseline gap-2 bg-background px-0.5 pt-[18px] pb-1.5 text-[15px] font-medium tracking-[-0.01em]">
        Agents <span className="font-mono text-[11px] font-normal text-dim">{view.agentCount}</span>
        {view.pendingCount > 0 && (
          <span className="text-[11px] font-normal text-waiting">
            {view.pendingCount} à traiter
          </span>
        )}
      </h2>
      {view.head.length > 0 && (
        <ul aria-label="À traiter" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {view.head.map((todo) => (
            <TodoItem key={todo.id} todo={todo} agent={byId.get(todo.agentId)} {...actions} />
          ))}
        </ul>
      )}
      <ul aria-label="Agents du workspace" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {view.rows.map((row) => (
          <AgentRow
            key={row.agent.id}
            row={row}
            color={agentColor(row.agent, all)}
            onOpen={onOpen}
            {...actions}
          />
        ))}
      </ul>
    </aside>
  );
}
