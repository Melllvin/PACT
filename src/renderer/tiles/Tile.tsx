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
        'relative flex min-h-0 min-w-0 flex-col rounded-md border-2 border-(--agent-color) bg-[#0a0d12]',
        failed && 'halo shadow-[0_0_0_3px_rgb(201_70_70/30%),0_0_22px_rgb(201_70_70/45%)]',
      )}
      style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
    >
      {pulses > 0 && (
        <span
          key={pulses}
          aria-hidden
          className="pointer-events-none absolute -inset-0.5 animate-tile-pulse rounded-md border-2 border-(--agent-color) motion-reduce:[animation-duration:1ms]"
        />
      )}
      {terminals && (
        <TerminalView
          termId={agent.id}
          registry={terminals}
          label={`Terminal de ${title}`}
          className={cn('px-3 pt-2.5', acting ? 'pb-[46px]' : 'pb-3')}
        />
      )}
      <div
        role="toolbar"
        aria-label="Outils"
        className="absolute top-1.5 right-1.5 flex gap-0.5 rounded-[5px] bg-[#0a0d12]/80"
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
        <div className="absolute right-2.5 bottom-2.5 left-3 flex items-center justify-end gap-2">
          {failed && agent.lastError && (
            <span className="min-w-0 truncate text-[12px] text-destructive">
              {agent.lastError.message}
            </span>
          )}
          <TileActions state={agent.state} scheduledResume={agent.scheduledResume} {...actions} />
        </div>
      )}
    </article>
  );
}
