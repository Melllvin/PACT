import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { DetectedClis } from '../home/DetectedClis';
import { Home } from '../home/Home';
import { PermissionsDialog } from '../launch/PermissionsDialog';
import { QuickLaunch } from '../launch/QuickLaunch';
import type { AppStore } from '../store/app-store';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { Legend } from './Legend';
import { TabBar } from './TabBar';
import styles from './shell.module.css';

type Props = {
  store: AppStore;
  /** Resolves a dropped file to its path (window.pact.pathForFile in the app). */
  getPathForFile: (file: File) => string;
  /** Terminals of the agents and free terminals, created once outside React (main.tsx). */
  terminals?: TerminalRegistry | undefined;
};

export function App({ store, getPathForFile, terminals }: Props) {
  const state = useStore(store);
  const { status, error, workspaces, activeTab, launcher } = state;
  const [now] = useState(() => new Date());

  useEffect(() => {
    const disconnect = store.getState().connect();
    void store.getState().load();
    return disconnect;
  }, [store]);

  // Frees the terminals whose agent or free terminal is gone (closed workspace, exited shell).
  const termIds = workspaces
    .flatMap((w) => [...w.agents.map((a) => a.id), ...w.freeTerminals.map((t) => t.id)])
    .join(' ');
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(termIds.split(' ').filter(Boolean));
    const gone = [...shown.current].filter((id) => !current.has(id));
    if (terminals) for (const id of gone) terminals.dispose(id);
    shown.current = current;
  }, [termIds, terminals]);

  const workspace =
    activeTab.kind === 'workspace' ? workspaces.find((w) => w.id === activeTab.id) : undefined;
  const launching = launcher && workspaces.find((w) => w.id === launcher.workspaceId);

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
        {status === 'ready' && workspace && (
          <WorkspaceView
            workspace={workspace}
            clis={state.clis}
            terminals={terminals}
            onAddAgents={() => {
              state.openLauncher(workspace.id);
            }}
          />
        )}
        {launcher?.step === 'counts' && launching && (
          <QuickLaunch
            clis={state.clis}
            counters={launching.quickLaunchCounters}
            existingAgents={launching.agents.length}
            error={launcher.error ?? null}
            onLaunch={(counts) => void state.requestLaunch(counts)}
            onClose={state.closeLauncher}
          />
        )}
        {launcher?.step === 'permission' && (
          <PermissionsDialog
            agentCount={Object.values(launcher.counts.agents).reduce((sum, n) => sum + n, 0)}
            clis={state.clis.filter((cli) => (launcher.counts.agents[cli.id] ?? 0) > 0)}
            onConfirm={(choice) => void state.confirmPermission(choice)}
            onCancel={state.closeLauncher}
          />
        )}
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
            <DetectedClis clis={state.clis} onRedetect={() => void state.redetectClis()} />
            <Legend />
          </>
        )}
      </main>
    </div>
  );
}
