import type { AgentState } from '../../shared/model';
import { tabIndicator } from '../../shared/tab-indicator';
import type { ActiveTab } from '../store/app-store';
import styles from './shell.module.css';

type Props = {
  workspaces: { id: string; name: string; agents?: { state: AgentState }[] }[];
  activeTab: ActiveTab;
  onSelect: (id: string) => void;
  onHome: () => void;
  onClose?: (id: string) => void;
  /** Closes the home tab back to a workspace; only offered when one is open. */
  onCloseHome?: () => void;
};

const INDICATORS = {
  waiting: { icon: '◆', label: 'un agent attend une réponse', className: styles.waiting },
  error: { icon: '✕', label: 'un agent est en erreur', className: styles.danger },
};

/** One tab per open workspace, a home tab opened by « + » (FR-002), settings inactive in the core. */
export function TabBar({ workspaces, activeTab, onSelect, onHome, onClose, onCloseHome }: Props) {
  const homeOpen = activeTab.kind === 'home';
  return (
    <header className={styles.tabBar}>
      <h1 className={styles.visuallyHidden}>PACT</h1>
      <div role="tablist" aria-label="Espaces de travail" className={styles.tabs}>
        {workspaces.map(({ id, name, agents = [] }) => {
          const selected = activeTab.kind === 'workspace' && activeTab.id === id;
          // Only a tab in the background needs to call for attention (FR-030).
          const indicator = selected ? null : tabIndicator(agents);
          return (
            <span key={id} className={styles.tabGroup}>
              <button
                role="tab"
                aria-selected={selected}
                className={styles.tab}
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
                  className={INDICATORS[indicator].className}
                >
                  {INDICATORS[indicator].icon}
                </span>
              )}
              {onClose && (
                <button
                  className={styles.close}
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
          <span className={styles.tabGroup}>
            <button role="tab" aria-selected className={styles.tab}>
              Nouvel onglet
            </button>
            {onCloseHome && workspaces.length > 0 && (
              <button
                className={styles.close}
                aria-label="Fermer Nouvel onglet"
                onClick={onCloseHome}
              >
                ✕
              </button>
            )}
          </span>
        )}
      </div>
      <button className={styles.iconButton} aria-label="Nouvel onglet" onClick={onHome}>
        +
      </button>
      <span className={styles.spacer} />
      <button className={styles.iconButton} aria-label="Réglages" disabled>
        ⚙
      </button>
    </header>
  );
}
