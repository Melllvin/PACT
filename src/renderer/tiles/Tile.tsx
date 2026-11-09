import { agentName } from '../../shared/agent-name';
import { useState, type CSSProperties } from 'react';
import type { Agent, AgentState } from '../../shared/model';
import { BranchTooltip } from './BranchTooltip';
import { TerminalView } from './TerminalView';
import {
  TileActions,
  type DeliveryAction,
  type TileActionHandlers,
  type TileMenu,
} from './TileActions';
import type { TerminalRegistry } from './terminal-registry';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '../../shared/roles';

const BADGE =
  'rounded-md border border-(--agent-color)/40 bg-surface/80 px-1.5 py-0.5 text-[11px] text-(--agent-color)';

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
  /** 006 — the ⋮ menu: « Faire orchestrateur », « Renommer ». */
  menu?: TileMenu | undefined;
  /** 008 — « Livrer » / « Intégrer » of the agent. */
  delivery?: DeliveryAction | undefined;
  /** 006 #46 — the color of the agent among its workspace's (a shade of its orchestrator's). */
  color?: string | undefined;
  /** ⤢: opens the Focus on this agent (US5). */
  onExpand?: (() => void) | undefined;
  /** 003 FR-010 — the agent works on a prompt of the orchestrator. */
  fromOrchestrator?: boolean;
  /** 004 US2 — the round of the loop the agent works in, if any. */
  round?: number | null;
  /** 004 US2 — the orchestrator's « Rapports » band: what its loops told, the latest last. */
  reports?: readonly { kind: string; summary: string }[];
};

/** The band shows the latest reports only; the Focus keeps them all. */
const BAND_REPORTS = 3;

/**
 * An agent tile (screens 1f, 1n): the raw CLI, bordered with the agent's color. The border pulses
 * once on each change of state and keeps a red halo in error (FR-020…FR-024).
 */
export function Tile({
  agent,
  name,
  terminals,
  onClose,
  menu,
  delivery,
  color,
  onExpand,
  fromOrchestrator = false,
  round = null,
  reports = [],
  ...actions
}: Props) {
  // Counted during render: a pulse per state change, none for the first one shown.
  const [seen, setSeen] = useState(agent.state);
  const [pulses, setPulses] = useState(0);
  if (seen !== agent.state) {
    setSeen(agent.state);
    setPulses(pulses + 1);
  }

  const title = agentName(agent, () => name);
  const failed = agent.state === 'error';
  // The buttons of the state show on hover or focus only, over the terminal (FR-022); the outline
  // says that one is due.
  const reviewing =
    actions.onReview !== undefined && (agent.state === 'done' || agent.state === 'awaiting-prompt');
  const delivering =
    delivery !== undefined && (agent.state === 'done' || agent.state === 'awaiting-prompt');
  const acting =
    agent.state === 'awaiting-answer' ||
    agent.state === 'closed' ||
    failed ||
    reviewing ||
    delivering;
  return (
    <article
      data-fx-shield
      aria-label={`${title}, ${STATE_LABELS[agent.state]}`}
      data-state={agent.state}
      data-pulse={pulses}
      className={cn(
        'group relative flex min-h-0 min-w-0 animate-tile-enter flex-col rounded-[14px] border border-[color-mix(in_srgb,var(--agent-color)_55%,transparent)] bg-surface transition-[border-color,box-shadow] duration-500 ease-out-soft motion-reduce:animate-none',
        acting && !failed && agent.state !== 'closed' && 'ring-1 ring-(--pulse-color)',
        failed &&
          'halo border-destructive shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_60%,transparent),0_0_40px_color-mix(in_srgb,var(--danger)_18%,transparent)]',
      )}
      style={
        {
          '--agent-color': color ?? `var(--agent-${agent.color})`,
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
          className="px-4 pt-10 pb-3.5"
        />
      )}
      {agent.role === 'orchestrator' && reports.length > 0 && (
        <ol
          aria-label="Rapports"
          className="mx-4 mb-3 flex flex-none flex-col gap-0.5 border-t border-white/6 pt-2 font-mono text-[12px] text-dim"
        >
          {reports.slice(-BAND_REPORTS).map((report, index) => (
            <li key={index} data-kind={report.kind} className="truncate">
              {report.summary.split('\n')[0]}
            </li>
          ))}
        </ol>
      )}
      {(agent.role !== null || fromOrchestrator) && (
        <span className="absolute top-2.5 left-3 flex gap-1">
          {agent.role !== null && agent.role !== 'orchestrator' && (
            // 004 FR-006: the role of the agent, at a glance.
            <span aria-label="Rôle" className={BADGE}>
              {ROLE_LABELS[agent.role]}
            </span>
          )}
          {round !== null && (
            <span aria-label="Tour" className={BADGE}>
              tour {round}/3
            </span>
          )}
          {(agent.role === 'orchestrator' || fromOrchestrator) && (
            <span
              {...(agent.role === 'orchestrator' && { 'aria-label': 'Rôle' })}
              className={BADGE}
            >
              {agent.role === 'orchestrator' ? '◎ Orchestrateur' : '◎ de l’orchestrateur'}
            </span>
          )}
        </span>
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
      {(acting || menu) && (
        // Hover on the tile, but focus on the buttons only: the terminal keeps the focus of the tile.
        <div className="group/actions absolute right-3 bottom-3 left-4">
          <div className="flex items-center justify-end gap-2 opacity-0 transition-opacity duration-200 group-focus-within/actions:opacity-100 group-hover:opacity-100">
            {failed && agent.lastError && (
              <span className="min-w-0 truncate font-mono text-[12px] text-[#f2a0a0]">
                {agent.lastError.message}
              </span>
            )}
            <TileActions
              state={agent.state}
              question={agent.awaiting === 'question'}
              scheduledResume={agent.scheduledResume}
              menu={menu}
              delivery={delivery}
              {...actions}
            />
          </div>
        </div>
      )}
    </article>
  );
}
