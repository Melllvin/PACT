import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { DetectedClis } from '../home/DetectedClis';
import { Home } from '../home/Home';
import { PermissionsDialog } from '../launch/PermissionsDialog';
import { LaunchPanel } from '../launch/LaunchPanel';
import type { Agent } from '../../shared/model';
import type { AppStore } from '../store/app-store';
import { CloseAgentDialog } from '../tiles/CloseAgentDialog';
import { LogPanel } from '../tiles/LogPanel';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { Legend } from './Legend';
import { TabBar } from './TabBar';

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
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);

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
  const agentsById = new Map(workspaces.flatMap((w) => w.agents).map((a) => [a.id, a]));
  const agentName = (agent: Agent) =>
    `${state.clis.find((c) => c.id === agent.cliId)?.name ?? agent.cliId} ${String(agent.position)}`;
  const closing = state.closingAgentId === null ? undefined : agentsById.get(state.closingAgentId);
  const logged = state.log === null ? undefined : agentsById.get(state.log.agentId);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <TabBar
        workspaces={workspaces}
        activeTab={activeTab}
        onSelect={state.selectWorkspace}
        onHome={state.openHome}
        onClose={(id) => void state.closeWorkspace(id)}
        onCloseHome={state.closeHome}
        toolbarRef={setToolbarSlot}
      />
      <main className="relative min-h-0 overflow-auto">
        {status === 'error' && (
          <p role="alert" className="m-4 text-destructive">
            {error}
          </p>
        )}
        {status === 'ready' && workspace && (
          <WorkspaceView
            workspace={workspace}
            clis={state.clis}
            terminals={terminals}
            toolbarSlot={toolbarSlot}
            onAddAgents={() => {
              state.openLauncher(workspace.id);
            }}
            actions={{
              onAnswer: (id, answer, always) => void state.answerAgent(id, answer, always),
              onResume: (id) => void state.resumeAgent(id),
              onRestart: (id) => void state.restartAgent(id),
              onLog: (id) => void state.openLog(id),
              onCancelAutoResume: (id) => void state.cancelAutoResume(id),
              onClose: state.requestCloseAgent,
            }}
            actionError={state.actionError}
          />
        )}
        {closing && (
          <CloseAgentDialog
            name={agentName(closing)}
            branch={closing.branch}
            onConfirm={(removeWorktree) => void state.closeAgent(removeWorktree)}
            onCancel={state.cancelCloseAgent}
          />
        )}
        {state.log && logged && (
          <LogPanel name={agentName(logged)} text={state.log.text} onClose={state.closeLog} />
        )}
        {launcher?.step === 'counts' && launching && (
          <LaunchPanel
            clis={state.clis}
            counters={launching.quickLaunchCounters}
            running={launching.agents}
            taken={workspaces.flatMap((w) => w.agents)}
            initialDraft={launcher.draft ?? null}
            error={launcher.error ?? null}
            onLaunch={(draft) => void state.requestLaunch(draft)}
            onClose={state.closeLauncher}
          />
        )}
        {launcher?.step === 'permission' && (
          <PermissionsDialog
            agentCount={launcher.draft.agents.length}
            clis={state.clis.filter((cli) =>
              launcher.draft.agents.some((agent) => agent.cliId === cli.id),
            )}
            onConfirm={(choice) => void state.confirmPermission(choice)}
            onCancel={state.closeLauncher}
          />
        )}
        {status === 'ready' && !workspace && (
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
            aside={
              <>
                <DetectedClis
                  clis={state.clis}
                  onRedetect={() => void state.redetectClis()}
                  onAdd={state.addCli}
                />
                <Legend />
              </>
            }
          />
        )}
      </main>
    </div>
  );
}
