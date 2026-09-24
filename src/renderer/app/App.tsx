import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Home } from '../home/Home';
import type { AppStore } from '../store/app-store';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { Legend } from './Legend';
import { TabBar } from './TabBar';
import styles from './shell.module.css';

type Props = {
  store: AppStore;
  /** Resolves a dropped file to its path (window.pact.pathForFile in the app). */
  getPathForFile: (file: File) => string;
};

export function App({ store, getPathForFile }: Props) {
  const state = useStore(store);
  const { status, error, workspaces, activeTab } = state;
  const [now] = useState(() => new Date());

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
        onSelect={state.selectWorkspace}
        onHome={state.openHome}
        onClose={(id) => void state.closeWorkspace(id)}
        onCloseHome={state.closeHome}
      />
      <main className={styles.stage}>
        {status === 'error' && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {status === 'ready' && workspace && <WorkspaceView workspace={workspace} />}
        {status === 'ready' && !workspace && (
          <>
            <Home
              workspaces={workspaces}
              recents={state.recents}
              now={now}
              openError={state.openError}
              clone={state.clone}
              onGoTo={state.selectWorkspace}
              onOpenPath={(path) => void state.openRepository(path)}
              onInitRepo={(path) => void state.initRepository(path)}
              onPickRepository={() => void state.pickRepository()}
              onPickCloneDestination={state.pickCloneDestination}
              onClone={(url, destination) => void state.startClone(url, destination)}
              getPathForFile={getPathForFile}
            />
            <Legend />
          </>
        )}
      </main>
    </div>
  );
}
