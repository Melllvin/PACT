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
  'flex items-center gap-1.5 rounded-md border border-transparent py-1 pr-1.5 pl-[11px] text-[12.5px] text-muted-foreground has-[[aria-selected=true]]:border-border has-[[aria-selected=true]]:bg-card has-[[aria-selected=true]]:font-semibold has-[[aria-selected=true]]:text-foreground';
const TAB_BUTTON = 'cursor-pointer outline-none focus-visible:underline';
const CLOSE =
  'flex size-4 cursor-pointer items-center justify-center rounded-sm text-[10px] text-muted-foreground hover:bg-white/5 hover:text-foreground';
const ICON =
  'flex size-[26px] cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-45';

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
    <header className="flex h-[42px] flex-none items-center gap-2 border-b border-border bg-[#11151c] px-3.5">
      <h1 className="sr-only">PACT</h1>
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
                  className={cn('text-[10px]', INDICATORS[indicator].className)}
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
        className={cn(ICON, 'size-6 text-[16px]')}
        aria-label="Nouvel onglet"
        onClick={onHome}
      >
        +
      </button>
      <span className="flex-1" />
      <div ref={toolbarRef} className="contents" />
      <button className={cn(ICON, 'text-[15px]')} aria-label="Réglages" disabled>
        ⚙
      </button>
    </header>
  );
}
