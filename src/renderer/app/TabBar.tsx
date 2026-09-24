import type { ActiveTab } from '../store/app-store';
import styles from './shell.module.css';

type Props = {
  workspaces: { id: string; name: string }[];
  activeTab: ActiveTab;
  onSelect: (id: string) => void;
  onHome: () => void;
};

/** One tab per open workspace, a home tab opened by « + » (FR-002), settings inactive in the core. */
export function TabBar({ workspaces, activeTab, onSelect, onHome }: Props) {
  const homeOpen = activeTab.kind === 'home';
  return (
    <header className={styles.tabBar}>
      <h1 className={styles.visuallyHidden}>PACT</h1>
      <div role="tablist" aria-label="Espaces de travail" className={styles.tabs}>
        {workspaces.map(({ id, name }) => {
          const selected = activeTab.kind === 'workspace' && activeTab.id === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={selected}
              className={styles.tab}
              onClick={() => {
                onSelect(id);
              }}
            >
              {name}
            </button>
          );
        })}
        {homeOpen && (
          <button role="tab" aria-selected className={styles.tab}>
            Accueil
          </button>
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
