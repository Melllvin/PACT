import { useState, type CSSProperties } from 'react';
import type { Agent, AgentState } from '../../shared/model';
import { BranchTooltip } from './BranchTooltip';
import { TerminalView } from './TerminalView';
import { TileActions, type TileActionHandlers } from './TileActions';
import type { TerminalRegistry } from './terminal-registry';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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

/** The pulse takes the color of the state it announces, the agent's own otherwise (R17). */
const PULSE_COLORS: Partial<Record<AgentState, string>> = {
  'awaiting-answer': 'var(--waiting)',
  done: 'var(--accept)',
  error: 'var(--danger)',
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
  // The buttons of the state sit over the bottom of the terminal, which leaves them room (1f).
  const acting = agent.state === 'awaiting-answer' || failed;
  return (
    <article
      aria-label={`${title}, ${STATE_LABELS[agent.state]}`}
      data-state={agent.state}
      data-pulse={pulses}
      className={cn(
        'relative flex min-h-0 min-w-0 animate-enter flex-col rounded-[14px] border border-[color-mix(in_srgb,var(--agent-color)_55%,transparent)] bg-surface transition-[border-color,box-shadow] duration-500 ease-out-soft motion-reduce:animate-none',
        failed &&
          'halo border-destructive shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_60%,transparent),0_0_40px_color-mix(in_srgb,var(--danger)_18%,transparent)]',
      )}
      style={
        {
          '--agent-color': `var(--agent-${agent.color})`,
          '--pulse-color': PULSE_COLORS[agent.state] ?? 'var(--agent-color)',
          '--enter-index': String(agent.position - 1),
        } as CSSProperties
      }
    >
      {pulses > 0 && (
        <span
          key={pulses}
          aria-hidden
          className="pointer-events-none absolute -inset-px animate-tile-pulse rounded-[14px] motion-reduce:[animation-duration:1ms]"
        />
      )}
      {terminals && (
        <TerminalView
          termId={agent.id}
          registry={terminals}
          label={`Terminal de ${title}`}
          className={cn('px-4 pt-3.5', acting ? 'pb-14' : 'pb-3.5')}
        />
      )}
      <div
        role="toolbar"
        aria-label="Outils"
        className="absolute top-2 right-2 flex gap-0.5 rounded-lg bg-surface/80"
      >
        <BranchTooltip branch={agent.branch} port={agent.port} />
        {onExpand && (
          <Button variant="ghost" size="icon" aria-label="Agrandir" onClick={onExpand}>
            ⤢
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Fermer l’agent" onClick={onClose}>
          ×
        </Button>
      </div>
      {acting && (
        <div className="absolute right-3 bottom-3 left-4 flex items-center justify-end gap-2">
          {failed && agent.lastError && (
            <span className="min-w-0 truncate font-mono text-[12px] text-[#f2a0a0]">
              {agent.lastError.message}
            </span>
          )}
          <TileActions state={agent.state} scheduledResume={agent.scheduledResume} {...actions} />
        </div>
      )}
    </article>
  );
}
