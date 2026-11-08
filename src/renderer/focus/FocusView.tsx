import { agentName } from '../../shared/agent-name';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Agent } from '../../shared/model';
import { exchangeMessageSchema, type ExchangeMessage } from '../../shared/exchanges';
import type { OrchestratorAction } from '../../shared/orchestrator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TerminalView } from '../tiles/TerminalView';
import { TileActions, type TileMenu } from '../tiles/TileActions';
import { visibleTabs } from './visible-tabs';
import { agentColor } from '../../shared/agent-color';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import type { AgentActions } from '../workspace/WorkspaceView';
import { AgentPills } from './AgentPills';
import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '../../shared/roles';

export type FocusTab = 'terminal' | 'changes' | 'conflicts' | 'actions' | 'reports' | 'preview';

type Props = Omit<AgentActions, 'onClose'> & {
  /** Given by the workspace along with the other actions; the Focus has no use for it. */
  onClose?: AgentActions['onClose'];
  /** 006 — the ⋮ menu of the footer: « Faire orchestrateur » and « Renommer ». */
  menu?: TileMenu | undefined;
  /** #43 — files of the diff of the agent; absent: `changes` given means there are some. */
  changedFiles?: number;
  tab?: FocusTab;
  onTab?: (tab: FocusTab) => void;
  /** The Changements tab (002 US1), shown above the same terminal. */
  changes?: ReactNode;
  /** The Conflits tab of screen 1q, while an integration is stopped on a conflict (002 US4). */
  conflicts?: { count: number; content: ReactNode } | undefined;
  /** 003 US5 — the orchestrator's journal « ◎ Actions » and the withdrawal of its role. */
  orchestration?:
    | {
        actions: OrchestratorAction[];
        onRevoke: () => void;
        /** 007 — the messages of the workspace, merged with the actions by time. */
        messages?: readonly unknown[];
      }
    | undefined;
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

const TAB_LABELS: Record<Exclude<FocusTab, 'conflicts'>, string> = {
  terminal: 'Terminal',
  preview: 'Aperçu',
  changes: 'Changements',
  actions: '◎ Actions',
  reports: '◎ Rapports',
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
  menu,
  changedFiles,
}: Props) {
  const terminalBox = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  useLayoutEffect(() => {
    back.current = onBack;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the CLI in its terminal, to a field being typed in, and to a dialog.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
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
  const title = agentName(agent, name);
  // #43 — a tab shows once it has something to show; the one open stays while its panel is given.
  const panels: Record<FocusTab, boolean> = {
    terminal: true,
    preview: preview !== undefined,
    changes: changes !== undefined,
    conflicts: conflicts !== undefined,
    actions: orchestration !== undefined,
    reports: reports !== undefined,
  };
  const conflictCount = conflicts?.count ?? 0;
  const offered = visibleTabs(agent, {
    served: preview !== undefined,
    changedFiles: changedFiles ?? (changes !== undefined ? 1 : 0),
    // The journal is read when its tab opens: the orchestrator's tab is offered before it is loaded.
    actions: orchestration ? 1 : 0,
    reports: reports !== undefined ? 1 : 0,
    conflicts: conflictCount,
  });
  const shownTabs = offered.includes(tab) || !panels[tab] ? offered : [...offered, tab];
  // The open tab went away with its content: back to the terminal.
  const active = panels[tab] ? tab : 'terminal';
  const failed = agent.state === 'error';
  return (
    <section
      data-fx-shield
      aria-label={`Focus : ${title}`}
      data-state={agent.state}
      style={{ '--agent-color': agentColor(agent, agents) } as CSSProperties}
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
          value={active}
          // Only the tabs below can be chosen.
          onValueChange={(value) => onTab?.(value as FocusTab)}
        >
          <TabsList variant="line" className="h-auto gap-4 p-0">
            {shownTabs.map((value) => (
              <TabsTrigger key={value} value={value} className={TAB}>
                {value === 'conflicts' ? `Conflits · ${String(conflictCount)}` : TAB_LABELS[value]}
              </TabsTrigger>
            ))}
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* #42 — under another tab the terminal is hidden, not unmounted: its session is kept, and
            the panel has the whole tile. */}
        <div
          ref={terminalBox}
          aria-hidden={active !== 'terminal'}
          className={cn(
            'flex min-h-0 flex-col',
            active === 'terminal' ? 'flex-1' : 'pointer-events-none invisible absolute inset-0',
          )}
        >
          {terminals && (
            <TerminalView termId={agent.id} registry={terminals} label={`Terminal de ${title}`} />
          )}
        </div>
        {active === 'changes' && changes}
        {active === 'conflicts' && conflicts?.content}
        {active === 'actions' && orchestration && (
          <ActionsJournal {...orchestration} name={(id) => nameOf(agents, id, name)} />
        )}
        {active === 'reports' && reports}
        {active === 'preview' && preview}
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
          menu={menu}
        />
      </footer>
    </section>
  );
}

const nameOf = (agents: Agent[], id: string | null, name: (cliId: string) => string) => {
  const agent = agents.find((a) => a.id === id);
  return agent ? agentName(agent, name) : null;
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** « ◎ Actions » (FR-021): what the orchestrator did, the latest first; its role can go (FR-004). */
function ActionsJournal({
  actions,
  onRevoke,
  messages = [],
  name,
}: {
  actions: OrchestratorAction[];
  onRevoke: () => void;
  messages?: readonly unknown[];
  name: (agentId: string | null) => string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const entries = [
    ...actions.map((action) => ({ at: action.at, action })),
    ...messages.flatMap((raw): { at: string; message: ExchangeMessage }[] => {
      // The journal comes from a file the agents write to: it is checked, not trusted.
      const parsed = exchangeMessageSchema.safeParse(raw);
      return parsed.success ? [{ at: parsed.data.at, message: parsed.data }] : [];
    }),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul
        aria-label="Actions de l’orchestrateur"
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2 text-[12.5px]"
      >
        {entries.length === 0 && <li className="text-dim">Aucune action pour l’instant.</li>}
        {entries.map((entry) =>
          'message' in entry ? (
            <li
              key={entry.message.id}
              data-type={entry.message.type}
              className={cn(
                'flex gap-3 border-b border-white/4 py-1.5',
                entry.message.type === 'info' && 'text-dim',
              )}
            >
              <span className="font-mono text-[11px] text-dim">
                {TIME.format(new Date(entry.message.at))}
              </span>
              <span className="text-muted-foreground">
                {entry.message.from === 'pact' ? 'PACT' : (name(entry.message.from) ?? '?')} →{' '}
                {name(entry.message.to) ?? '?'}
              </span>
              <span className="font-mono text-[11px]">
                {entry.message.type} · {entry.message.kind}
              </span>
              <span className="min-w-0 flex-1 break-words">{entry.message.text}</span>
            </li>
          ) : (
            <ActionRow key={entry.action.id} action={entry.action} name={name} />
          ),
        )}
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

function ActionRow({
  action,
  name,
}: {
  action: OrchestratorAction;
  name: (agentId: string | null) => string | null;
}) {
  return (
    <li className="flex gap-3 border-b border-white/4 py-1.5">
      <span className="font-mono text-[11px] text-dim">{TIME.format(new Date(action.at))}</span>
      <span className="font-mono text-[11px]">{action.tool}</span>
      {name(action.agentId) && (
        <span className="text-muted-foreground">{name(action.agentId)}</span>
      )}
      <span className="flex-1">{action.summary}</span>
      {action.outcome === 'refused' && (
        <span className="text-[#f2a0a0]">refusé : {action.reason}</span>
      )}
    </li>
  );
}
