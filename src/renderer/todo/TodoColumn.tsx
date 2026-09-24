import type { Agent, TodoItem as Todo } from '../../shared/model';
import type { AgentActions } from '../workspace/WorkspaceView';
import { TodoItem } from './TodoItem';
import styles from './todo.module.css';

type Props = Omit<AgentActions, 'onClose'> & {
  todos: Todo[];
  agents: Agent[];
};

/** The À faire column (screens 1f, 1l): what the agents need, answers first (FR-027). */
export function TodoColumn({ todos, agents, ...actions }: Props) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <aside aria-label="À faire" className={styles.column}>
      {todos.length === 0 ? (
        <p className={styles.empty}>Rien à faire · vous serez prévenu</p>
      ) : (
        <ul aria-label="À faire" className={styles.list}>
          {todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} agent={byId.get(todo.agentId)} {...actions} />
          ))}
        </ul>
      )}
    </aside>
  );
}
