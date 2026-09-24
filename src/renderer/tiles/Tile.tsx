import { useState, type CSSProperties } from 'react';
import type { Agent, AgentState } from '../../shared/model';
import { BranchTooltip } from './BranchTooltip';
import { TerminalView } from './TerminalView';
import { TileActions, type TileActionHandlers } from './TileActions';
import type { TerminalRegistry } from './terminal-registry';
import styles from './tiles.module.css';

/** FR-041: the state in words, for assistive technologies only (FR-020 shows none). */
const STATE_LABELS: Record<AgentState, string> = {
  starting: 'démarre',
  'awaiting-prompt': 'attend une consigne',
  working: 'en cours',
  'awaiting-answer': 'attend votre réponse',
  done: 'terminé',
  error: 'erreur',
  closed: 'fermé',
};

type Props = TileActionHandlers & {
  agent: Agent;
  name: string;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
  onClose: () => void;
  /** ⤢: opens the Focus on this agent (US5). */
  onExpand?: (() => void) | undefined;
};

/**
 * An agent tile (screens 1f, 1n): the raw CLI, bordered with the agent's color. The border pulses
 * once on each change of state and keeps a red halo in error (FR-020…FR-024).
 */
export function Tile({ agent, name, terminals, onClose, onExpand, ...actions }: Props) {
  // Counted during render: a pulse per state change, none for the first one shown.
  const [seen, setSeen] = useState(agent.state);
  const [pulses, setPulses] = useState(0);
  if (seen !== agent.state) {
    setSeen(agent.state);
    setPulses(pulses + 1);
  }

  const title = `${name} ${String(agent.position)}`;
  const failed = agent.state === 'error';
  return (
    <article
      aria-label={`${title}, ${STATE_LABELS[agent.state]}`}
      data-state={agent.state}
      data-pulse={pulses}
      className={[styles.tile, failed && styles.halo].filter(Boolean).join(' ')}
      style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
    >
      {pulses > 0 && <span key={pulses} className={styles.pulse} aria-hidden />}
      {terminals && (
        <TerminalView termId={agent.id} registry={terminals} label={`Terminal de ${title}`} />
      )}
      <footer className={styles.bar}>
        <BranchTooltip branch={agent.branch} port={agent.port} />
        {onExpand && (
          <button className={styles.icon} aria-label="Agrandir" onClick={onExpand}>
            ⤢
          </button>
        )}
        <button className={styles.icon} aria-label="Fermer l’agent" onClick={onClose}>
          ×
        </button>
        <span className={styles.spacer} />
        {failed && agent.lastError && (
          <span className={styles.failure}>{agent.lastError.message}</span>
        )}
        <TileActions state={agent.state} {...actions} />
      </footer>
    </article>
  );
}
