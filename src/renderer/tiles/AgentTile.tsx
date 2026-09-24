import type { Agent, AgentState } from '../../shared/model';
import { TerminalView } from './TerminalView';
import type { TerminalRegistry } from './terminal-registry';
import styles from './tiles.module.css';

/** FR-041: one glyph per state, with its words for assistive technologies. */
const STATES: Record<AgentState, { icon: string; label: string }> = {
  starting: { icon: '…', label: 'démarre' },
  'awaiting-prompt': { icon: '✎', label: 'attend une consigne' },
  working: { icon: '▶', label: 'en cours' },
  'awaiting-answer': { icon: '◆', label: 'attend votre réponse' },
  done: { icon: '✓', label: 'terminé' },
  error: { icon: '✕', label: 'erreur' },
  closed: { icon: '■', label: 'fermé' },
};

type Props = {
  agent: Agent;
  name: string;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
};

/** Minimal tile until US3: colored border, branch, port, state and the agent's terminal. */
export function AgentTile({ agent, name, terminals }: Props) {
  const state = STATES[agent.state];
  const title = `${name} ${String(agent.position)}`;
  return (
    <article
      aria-label={title}
      className={styles.tile}
      style={{ borderColor: `var(--agent-${agent.color})` }}
    >
      <header className={styles.header}>
        <strong>{title}</strong>
        <span className={styles.meta}>{agent.branch}</span>
        <span className={styles.meta}>:{agent.port}</span>
        <span className={styles.spacer} />
        <span title={state.label} className={styles[agent.state]}>
          {state.icon}
          <span className={styles.hidden}> {state.label}</span>
        </span>
      </header>
      {agent.lastError && <p className={styles.failure}>{agent.lastError.message}</p>}
      {terminals && (
        <TerminalView termId={agent.id} registry={terminals} label={`Terminal de ${title}`} />
      )}
    </article>
  );
}
