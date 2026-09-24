import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { AppStore } from '../store/app-store';
import { Legend } from './Legend';
import { TabBar } from './TabBar';
import { Toolbar } from './Toolbar';
import styles from './shell.module.css';

export function App({ store }: { store: AppStore }) {
  const { status, error, workspaces, activeTab, selectWorkspace, openHome } = useStore(store);

  useEffect(() => {
    const disconnect = store.getState().connect();
    void store.getState().load();
    return disconnect;
  }, [store]);

  const workspace =
    activeTab.kind === 'workspace' ? workspaces.find((w) => w.id === activeTab.id) : undefined;

  return (
    <div className={styles.app}>
      <TabBar
        workspaces={workspaces}
        activeTab={activeTab}
        onSelect={selectWorkspace}
        onHome={openHome}
      />
      {workspace && <Toolbar todoCount={0} />}
      <main className={styles.stage}>
        {status === 'error' && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {status === 'ready' && !workspace && <Legend />}
      </main>
    </div>
  );
}
