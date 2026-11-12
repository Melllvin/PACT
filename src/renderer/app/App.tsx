import { agentName } from '../../shared/agent-name';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { DetectedClis } from '../home/DetectedClis';
import { Home } from '../home/Home';
import { PermissionsDialog } from '../launch/PermissionsDialog';
import { LaunchPanel } from '../launch/LaunchPanel';
import { agentsLaunchedBy } from '../../shared/agents-view';
import { fallingDelivery } from '../../shared/delivery';
import type { Agent } from '../../shared/model';
import type { AppStore } from '../store/app-store';
import type { PreviewApi } from '../focus/PreviewTab';
import { idleReviewStore, type ReviewStore } from '../store/review-store';
import { CloseAgentDialog, RestartGroupDialog } from '../tiles/CloseAgentDialog';
import { LogPanel } from '../tiles/LogPanel';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { AmbientCanvas } from '../effects/AmbientCanvas';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { RoleProfilesDialog } from '../settings/RoleProfiles';
import { launchWarning } from '../../shared/usage';
import { Button } from '@/components/ui/button';
import { Legend } from './Legend';
import { BUILD_INFO, formatBuildInfo } from '../../shared/build-info';
import { TabBar } from './TabBar';

type Props = {
  store: AppStore;
  /** Resolves a dropped file to its path (window.pact.pathForFile in the app). */
  getPathForFile: (file: File) => string;
  /** Terminals of the agents and free terminals, created once outside React (main.tsx). */
  terminals?: TerminalRegistry | undefined;
  /** The review of the Changements tab (002); without it, no review is offered. */
  review?: ReviewStore | undefined;
  /** 004 US4 — the Aperçu of the Focus; without it, the tab stays disabled. */
  preview?: PreviewApi | undefined;
};

export function App({ store, getPathForFile, terminals, review, preview }: Props) {
  const state = useStore(store);
  const reviewState = useStore(review ?? idleReviewStore);
  const { status, error, workspaces, activeTab, launcher } = state;
  const [now] = useState(() => new Date());
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  /** 004 US1 — the role profiles of the active workspace, open from « Rôles ». */
  const [rolesOpen, setRolesOpen] = useState(false);

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
  const nameOfAgent = (agent: Agent) =>
    agentName(agent, (cliId) => state.clis.find((c) => c.id === cliId)?.name ?? cliId);
  const closing = state.closingAgentId === null ? undefined : agentsById.get(state.closingAgentId);
  const restarting =
    state.restartingAgentId === null ? undefined : agentsById.get(state.restartingAgentId);
  // 006: what closes, or restarts, with an orchestrator are the agents it launched.
  const groupOf = (agent: Agent, only?: Agent['state']) =>
    (agent.role === 'orchestrator'
      ? agentsLaunchedBy({ agents: [...agentsById.values()] }, agent.id)
      : []
    )
      .filter((member) => only === undefined || member.state === only)
      .map((member) => ({ id: member.id, name: nameOfAgent(member) }));
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
          {status === 'ready' &&
            workspace &&
            toolbarSlot &&
            createPortal(
              <Button
                className="h-8 rounded-[9px] px-3 text-[12.5px]"
                onClick={() => {
                  setRolesOpen(true);
                }}
              >
                Rôles
              </Button>,
              toolbarSlot,
            )}
          {rolesOpen && workspace && (
            <RoleProfilesDialog
              clis={state.clis}
              stored={workspace.roleProfiles}
              onChange={(profiles) => void state.setRoleProfiles(workspace.id, profiles)}
              onClose={() => {
                setRolesOpen(false);
              }}
            />
          )}
          {status === 'ready' && workspace && (
            <WorkspaceView
              workspace={workspace}
              clis={state.clis}
              terminals={terminals}
              toolbarSlot={toolbarSlot}
              usage={Object.values(state.usage)}
              focusRequest={state.focusRequest}
              usageThresholds={state.usageThresholds}
              onUsageThresholds={(thresholds) => void state.setUsageThresholds(thresholds)}
              onAddAgents={() => {
                state.openLauncher(workspace.id);
              }}
              actions={{
                onAnswer: (id, answer, always) => void state.answerAgent(id, answer, always),
                onResume: (id) => void state.resumeAgent(id),
                onRestart: (id) => {
                  // 006: a closed tile asks « Reprendre le travail » first (FR-026).
                  if (agentsById.get(id)?.state === 'closed') state.requestRestartAgent(id);
                  else void state.restartAgent(id);
                },
                onLog: (id) => void state.openLog(id),
                onCancelAutoResume: (id) => void state.cancelAutoResume(id),
                onClose: state.requestCloseAgent,
                onPromote: (id) => void state.promoteAgent(id),
                onRename: (id, name) => void state.renameAgent(id, name),
                onDecideDelivery: (id, decision, head, reason) =>
                  void state.decideDelivery(id, decision, head, reason),
                onOpenPr: (id) => void state.openDeliveryPr(id),
                onCleanup: state.cleanupWorktree,
                onDeliverySettings: (settings) =>
                  void state.setDeliverySettings(workspace.id, settings),
                onRequestDelivery: (agentId, request) =>
                  void state.requestDelivery(workspace.id, agentId, request),
                onDecideLoop: (issueId, decision) =>
                  void state.decideLoop(workspace.id, issueId, decision),
                onDecideExchange: (escalationId, decision) =>
                  void state.decideExchange(workspace.id, escalationId, decision),
                onConfirmPublish: (id) => void state.confirmPublish(id),
                onRefusePublish: (id) => void state.refusePublish(id),
              }}
              actionError={state.actionError}
              fromOrchestrator={state.orchestratorPrompted}
              loopReports={state.loopReports[workspace.id] ?? []}
              preview={preview}
              orchestration={{
                actions: state.orchestratorActions,
                load: (id) => void state.loadOrchestratorActions(id),
                revoke: (id) => void state.revokeOrchestrator(id),
              }}
              review={
                review && {
                  pending: reviewState.pending[workspace.id] ?? [],
                  files: reviewState.files[workspace.id] ?? {},
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
                  comment: (agentId, path, line, text) =>
                    void state.commentLine(agentId, path, line, text),
                  send: (agentId, kind, text) => void state.sendToAgent(agentId, kind, text),
                  correcting: state.correcting,
                  integrations: reviewState.integrations,
                  resolveConflict: (agentId, path, answer) =>
                    void reviewState.resolveConflict(agentId, path, answer),
                  openInEditor: (agentId, path) => void reviewState.openInEditor(agentId, path),
                  askAgent: (agentId) => void reviewState.askAgent(agentId),
                  finishIntegration: (agentId, label) =>
                    void reviewState.finishIntegration(agentId, {
                      ...label,
                      workspaceId: workspace.id,
                    }),
                  cancelIntegration: (agentId) => void reviewState.cancelIntegration(agentId),
                }
              }
            />
          )}
          {closing && (
            <CloseAgentDialog
              name={nameOfAgent(closing)}
              branch={closing.branch}
              subAgents={groupOf(closing)}
              delivery={fallingDelivery(
                workspaces.flatMap((w) => w.deliveries),
                closing.id,
              )}
              onConfirm={(removeWorktree) => void state.closeAgent(removeWorktree)}
              onCancel={state.cancelCloseAgent}
            />
          )}
          {restarting && (
            <RestartGroupDialog
              name={nameOfAgent(restarting)}
              subAgents={groupOf(restarting, 'closed')}
              onConfirm={(resumeWork) => void state.confirmRestartAgent(resumeWork)}
              onCancel={state.cancelRestartAgent}
            />
          )}
          {state.log && logged && (
            <LogPanel name={nameOfAgent(logged)} text={state.log.text} onClose={state.closeLog} />
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
              profiles={launching.roleProfiles}
              usageWarning={(cliId) =>
                launchWarning(Object.values(state.usage), cliId, state.usageThresholds, new Date())
              }
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
              build={formatBuildInfo(BUILD_INFO)}
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
