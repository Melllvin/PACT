import type { Ref } from 'react';
import type { AgentState } from '../../shared/model';
import { tabIndicator } from '../../shared/tab-indicator';
import type { ActiveTab } from '../store/app-store';
import { cn } from '@/lib/utils';

type Props = {
  workspaces: { id: string; name: string; agents?: { state: AgentState }[] }[];
  activeTab: ActiveTab;
  onSelect: (id: string) => void;
  onHome: () => void;
  onClose?: (id: string) => void;
  /** Closes the home tab back to a workspace; only offered when one is open. */
  onCloseHome?: () => void;
  /** Where the active workspace puts its views and « + Agents » (1b). */
  toolbarRef?: Ref<HTMLDivElement>;
};

const INDICATORS = {
  waiting: { icon: '◆', label: 'un agent attend une réponse', className: 'text-waiting' },
  error: { icon: '✕', label: 'un agent est en erreur', className: 'text-destructive' },
};

const TAB =
  'flex h-[30px] flex-none items-center gap-2 rounded-lg pr-1.5 pl-3 text-[13px] whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-250 hover:text-foreground has-[[aria-selected=true]]:bg-white/7 has-[[aria-selected=true]]:text-foreground';
const TAB_BUTTON = 'cursor-pointer outline-none focus-visible:underline';
const CLOSE =
  'flex size-[18px] cursor-pointer items-center justify-center rounded-[5px] text-[10px] text-dim hover:bg-white/6 hover:text-foreground';
const ICON =
  'flex size-8 flex-none cursor-pointer items-center justify-center rounded-[9px] text-muted-foreground transition-[background-color,color] duration-250 enabled:hover:text-foreground disabled:cursor-default disabled:opacity-45';

/** One tab per open workspace, a home tab opened by « + » (FR-002), settings inactive in the core. */
export function TabBar({
  workspaces,
  activeTab,
  onSelect,
  onHome,
  onClose,
  onCloseHome,
  toolbarRef,
}: Props) {
  const homeOpen = activeTab.kind === 'home';
  return (
    <header className="relative z-10 flex h-[52px] flex-none items-center gap-1 border-b border-white/6 px-3.5">
      <h1 className="m-0 mr-1.5 flex h-5 flex-none items-center gap-[9px] border-r border-white/7 pr-4 pl-1 text-[13.5px] font-medium tracking-[-0.01em]">
        <span aria-hidden className="size-[9px] rounded-full bg-foreground" />
        PACT
      </h1>
      <div role="tablist" aria-label="Espaces de travail" className="flex min-w-0 gap-1">
        {workspaces.map(({ id, name, agents = [] }) => {
          const selected = activeTab.kind === 'workspace' && activeTab.id === id;
          // Only a tab in the background needs to call for attention (FR-030).
          const indicator = selected ? null : tabIndicator(agents);
          return (
            <span key={id} className={TAB}>
              <button
                role="tab"
                aria-selected={selected}
                className={TAB_BUTTON}
                onClick={() => {
                  onSelect(id);
                }}
              >
                {name}
              </button>
              {indicator && (
                <span
                  role="img"
                  aria-label={`${name} : ${INDICATORS[indicator].label}`}
                  className={cn('text-[8px]', INDICATORS[indicator].className)}
                >
                  {INDICATORS[indicator].icon}
                </span>
              )}
              {onClose && (
                <button
                  className={CLOSE}
                  aria-label={`Fermer ${name}`}
                  onClick={() => {
                    onClose(id);
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
        {homeOpen && (
          <span className={TAB}>
            <button role="tab" aria-selected className={TAB_BUTTON}>
              Nouvel onglet
            </button>
            {onCloseHome && workspaces.length > 0 && (
              <button className={CLOSE} aria-label="Fermer Nouvel onglet" onClick={onCloseHome}>
                ✕
              </button>
            )}
          </span>
        )}
      </div>
      <button
        className={cn(
          ICON,
          'size-[30px] rounded-lg text-[17px] font-light',
          homeOpen && 'bg-white/7 text-foreground',
        )}
        aria-label="Nouvel onglet"
        onClick={onHome}
      >
        +
      </button>
      <span className="flex-1" />
      <div ref={toolbarRef} className="contents" />
      <button className={cn(ICON, 'ml-1.5 text-[15px]')} aria-label="Réglages" disabled>
        ⚙
      </button>
    </header>
  );
}
