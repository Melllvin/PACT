import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { DetectedClis } from '../home/DetectedClis';
import { Home } from '../home/Home';
import { PermissionsDialog } from '../launch/PermissionsDialog';
import { LaunchPanel } from '../launch/LaunchPanel';
import type { Agent } from '../../shared/model';
import type { AppStore } from '../store/app-store';
import { idleReviewStore, type ReviewStore } from '../store/review-store';
import { CloseAgentDialog } from '../tiles/CloseAgentDialog';
import { LogPanel } from '../tiles/LogPanel';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { AmbientCanvas } from '../effects/AmbientCanvas';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { Legend } from './Legend';
import { TabBar } from './TabBar';

type Props = {
  store: AppStore;
  /** Resolves a dropped file to its path (window.pact.pathForFile in the app). */
  getPathForFile: (file: File) => string;
  /** Terminals of the agents and free terminals, created once outside React (main.tsx). */
  terminals?: TerminalRegistry | undefined;
  /** The review of the Changements tab (002); without it, no review is offered. */
  review?: ReviewStore | undefined;
};

export function App({ store, getPathForFile, terminals, review }: Props) {
  const state = useStore(store);
  const reviewState = useStore(review ?? idleReviewStore);
  const { status, error, workspaces, activeTab, launcher } = state;
  const [now] = useState(() => new Date());
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const disconnect = store.getState().connect();
    void store.getState().load();
    return disconnect;
  }, [store]);
  useEffect(() => review?.getState().connect(), [review]);

  // The review:pending events sent before this window existed are lost: ask once per workspace.
  const workspaceIds = workspaces.map((w) => w.id).join(' ');
  useEffect(() => {
    for (const id of workspaceIds.split(' ').filter(Boolean)) {
      void review?.getState().loadPending(id);
    }
  }, [workspaceIds, review]);

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
      {/* The ambient canvas stays put while the content scrolls, under it (R17). */}
      <div className="relative isolate min-h-0">
        {status === 'ready' && (
          <AmbientCanvas
            mode={workspace ? 'workspace' : 'home'}
            view={workspace ? workspace.id : 'home'}
          />
        )}
        <main className="h-full overflow-auto">
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
              review={
                review && {
                  pending: reviewState.pending[workspace.id] ?? [],
                  snapshot: reviewState.snapshot,
                  selected: reviewState.selected,
                  diff: reviewState.diff,
                  error: reviewState.error,
                  open: (agentId) => void reviewState.open(agentId),
                  close: reviewState.close,
                  select: (path) => void reviewState.select(path),
                  markSeen: (agentId, path, blob) => void state.markSeen(agentId, path, blob),
                  tests: reviewState.tests,
                  decisions: reviewState.decisions,
                  notice:
                    reviewState.notice?.workspaceId === workspace.id
                      ? reviewState.notice.text
                      : null,
                  runTests: (agentId) => void reviewState.runTests(agentId),
                  cancelTests: (agentId) => void reviewState.cancelTests(agentId),
                  setTestCommand: (agentId, command) =>
                    void reviewState.setTestCommand(workspace.id, agentId, command),
                  integrate: (agentId, request, label) =>
                    void reviewState.integrate(agentId, request, {
                      ...label,
                      workspaceId: workspace.id,
                    }),
                  dismissNotice: reviewState.dismissNotice,
                }
              }
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
              localChanges={launcher.localChanges ?? false}
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
    </div>
  );
}
