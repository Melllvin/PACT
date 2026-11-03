import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Agent } from '../../shared/model';
import type { OrchestratorAction } from '../../shared/orchestrator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TerminalView } from '../tiles/TerminalView';
import { TileActions } from '../tiles/TileActions';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import type { AgentActions } from '../workspace/WorkspaceView';
import { AgentPills } from './AgentPills';
import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '../../shared/roles';

export type FocusTab = 'terminal' | 'changes' | 'conflicts' | 'actions' | 'reports' | 'preview';

type Props = Omit<AgentActions, 'onClose'> & {
  tab?: FocusTab;
  onTab?: (tab: FocusTab) => void;
  /** The Changements tab (002 US1), shown above the same terminal. */
  changes?: ReactNode;
  /** The Conflits tab of screen 1q, while an integration is stopped on a conflict (002 US4). */
  conflicts?: { count: number; content: ReactNode } | undefined;
  /** 003 US5 — the orchestrator's journal « ◎ Actions » and the withdrawal of its role. */
  orchestration?: { actions: OrchestratorAction[]; onRevoke: () => void } | undefined;
  /** 004 FR-006a — « ◎ Rapports » of the orchestrator: the latest report of each agent. */
  reports?: ReactNode;
  /** 004 US4 — the Aperçu of the agent; without it, the tab stays disabled (001 FR-033). */
  preview?: ReactNode;
  /** Every agent of the workspace, in position order. */
  agents: Agent[];
  /** The agents offered as pills; all of them by default, those to review in the Revue view. */
  pills?: Agent[];
  agentId: string;
  name: (cliId: string) => string;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
  onSelect: (agentId: string) => void;
  onBack: () => void;
};

const TAB =
  'flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-2.5 pb-2 text-[12.5px] ' +
  'data-[state=active]:border-(--agent-color) data-[state=active]:bg-transparent ' +
  'data-[state=active]:font-semibold data-[state=active]:shadow-none after:bg-(--agent-color)';

/**
 * Focus (screen 1p): one agent large, opened by ⤢ or « Revue → ». Terminal and Changements
 * (screen 1h) are active, and Aperçu once given (004 FR-025). « ‹ Tuiles » or Escape outside the
 * terminal goes back to the grid (US5).
 */
export function FocusView({
  tab = 'terminal',
  onTab,
  changes,
  conflicts,
  orchestration,
  reports,
  preview,
  agents,
  pills = agents,
  agentId,
  name,
  terminals,
  onSelect,
  onBack,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onCancelAutoResume,
}: Props) {
  const terminalBox = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  useLayoutEffect(() => {
    back.current = onBack;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the CLI in its terminal, and to a dialog when one is open.
      if (event.target instanceof Node && terminalBox.current?.contains(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      back.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const title = `${name(agent.cliId)} ${String(agent.position)}`;
  const failed = agent.state === 'error';
  return (
    <section
      data-fx-shield
      aria-label={`Focus : ${title}`}
      data-state={agent.state}
      style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
      className="flex h-full min-h-0 animate-enter flex-col overflow-hidden rounded-[14px] border border-[color-mix(in_srgb,var(--agent-color)_55%,transparent)] bg-surface motion-reduce:animate-none"
    >
      <header className="flex h-12 flex-none items-center gap-3 border-b border-white/6 px-3.5">
        <button
          onClick={onBack}
          className="flex h-7 cursor-pointer items-center rounded-lg border border-white/8 px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:border-white/16 hover:text-foreground"
        >
          ‹ Tuiles
        </button>
        <AgentPills agents={pills} current={agent.id} name={name} onSelect={onSelect} />
        <span aria-hidden className="h-[18px] w-px bg-white/8" />
        <Tabs
          value={tab}
          // Only the tabs below can be chosen.
          onValueChange={(value) => onTab?.(value as FocusTab)}
        >
          <TabsList variant="line" className="h-auto gap-4 p-0">
            <TabsTrigger value="terminal" className={TAB}>
              Terminal
            </TabsTrigger>
            <TabsTrigger value="preview" disabled={preview === undefined} className={TAB}>
              Aperçu
            </TabsTrigger>
            <TabsTrigger value="changes" className={TAB}>
              Changements
            </TabsTrigger>
            {conflicts && (
              <TabsTrigger value="conflicts" className={TAB}>
                Conflits · {conflicts.count}
              </TabsTrigger>
            )}
            {orchestration && (
              <TabsTrigger value="actions" className={TAB}>
                ◎ Actions
              </TabsTrigger>
            )}
            {reports !== undefined && (
              <TabsTrigger value="reports" className={TAB}>
                ◎ Rapports
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        {agent.role !== null && (
          // 004 FR-006: the role, as on the tile.
          <span
            aria-label="Rôle"
            className="rounded-md border border-(--agent-color)/40 px-1.5 py-0.5 text-[11px] text-(--agent-color)"
          >
            {ROLE_LABELS[agent.role]}
          </span>
        )}
        <span className="font-mono text-[11px] text-dim">
          ⎇ {agent.branch} · :{agent.port}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'changes' && changes}
        {tab === 'conflicts' && conflicts?.content}
        {tab === 'actions' && orchestration && (
          <ActionsJournal {...orchestration} name={(id) => nameOf(agents, id, name)} />
        )}
        {tab === 'reports' && reports}
        {tab === 'preview' && preview}
        {/* Same place in the tree on both tabs: the terminal stays attached, its session kept. */}
        <div
          ref={terminalBox}
          className={cn(
            'flex min-h-0 flex-col',
            tab === 'terminal' ? 'flex-1' : 'h-[32%] flex-none border-t border-white/6',
          )}
        >
          {terminals && (
            <TerminalView termId={agent.id} registry={terminals} label={`Terminal de ${title}`} />
          )}
        </div>
      </div>
      <footer className="flex flex-none items-center justify-end gap-2 border-t border-white/6 px-3.5 py-2.5 text-[13px]">
        {failed && agent.lastError && (
          <span className="mr-auto font-mono text-[12px] text-[#f2a0a0]">
            {agent.lastError.message}
          </span>
        )}
        <TileActions
          state={agent.state}
          question={agent.awaiting === 'question'}
          scheduledResume={agent.scheduledResume}
          onOpenTerminal={() => {
            onTab?.('terminal');
          }}
          onAnswer={(answer) => {
            onAnswer(agent.id, answer);
          }}
          onAlways={() => {
            onAnswer(agent.id, 'allow', true);
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
          onCancelAutoResume={() => {
            onCancelAutoResume(agent.id);
          }}
        />
      </footer>
    </section>
  );
}

const nameOf = (agents: Agent[], id: string | null, name: (cliId: string) => string) => {
  const agent = agents.find((a) => a.id === id);
  return agent ? `${name(agent.cliId)} ${String(agent.position)}` : null;
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** « ◎ Actions » (FR-021): what the orchestrator did, the latest first; its role can go (FR-004). */
function ActionsJournal({
  actions,
  onRevoke,
  name,
}: {
  actions: OrchestratorAction[];
  onRevoke: () => void;
  name: (agentId: string | null) => string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul
        aria-label="Actions de l’orchestrateur"
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2 text-[12.5px]"
      >
        {actions.length === 0 && <li className="text-dim">Aucune action pour l’instant.</li>}
        {actions.map((action) => (
          <li key={action.id} className="flex gap-3 border-b border-white/4 py-1.5">
            <span className="font-mono text-[11px] text-dim">
              {TIME.format(new Date(action.at))}
            </span>
            <span className="font-mono text-[11px]">{action.tool}</span>
            {name(action.agentId) && (
              <span className="text-muted-foreground">{name(action.agentId)}</span>
            )}
            <span className="flex-1">{action.summary}</span>
            {action.outcome === 'refused' && (
              <span className="text-[#f2a0a0]">refusé : {action.reason}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-white/6 px-3.5 py-2 text-[12.5px]">
        {confirming ? (
          <>
            <span className="mr-auto text-muted-foreground">
              L’agent reste ouvert ; ses consignes en attente sont annulées et PACT refuse ses
              prochaines demandes.
            </span>
            <button
              onClick={() => {
                setConfirming(false);
              }}
              className="h-7 cursor-pointer rounded-lg border border-white/8 px-2.5"
            >
              Annuler
            </button>
            <button
              onClick={() => {
                setConfirming(false);
                onRevoke();
              }}
              className="h-7 cursor-pointer rounded-lg border border-[#f2a0a0]/40 px-2.5 text-[#f2a0a0]"
            >
              Retirer
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setConfirming(true);
            }}
            className="h-7 cursor-pointer rounded-lg border border-white/8 px-2.5 text-muted-foreground hover:text-foreground"
          >
            Retirer le rôle d’orchestrateur
          </button>
        )}
      </div>
    </div>
  );
}
