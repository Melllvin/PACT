import type { CSSProperties } from 'react';
import type { Agent, TodoItem as Todo } from '../../shared/model';
import { TileActions } from '../tiles/TileActions';
import type { AgentActions } from '../workspace/WorkspaceView';
import styles from './todo.module.css';

type Props = Omit<AgentActions, 'onClose'> & {
  todo: Todo;
  /** Absent for a free terminal, which has no color nor actions. */
  agent: Agent | undefined;
};

/** One request, in the color of its agent, with the same buttons as its tile (FR-028). */
export function TodoItem({ todo, agent, onAnswer, onResume, onRestart, onLog }: Props) {
  const style = agent && ({ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties);
  return (
    <li className={styles.item} data-kind={todo.kind} style={style}>
      <span className={styles.title}>{todo.title}</span>
      {agent && (
        <TileActions
          state={agent.state}
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
        />
      )}
    </li>
  );
}
