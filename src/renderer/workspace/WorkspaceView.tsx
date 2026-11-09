import type { UsageState, UsageThresholds } from '../../shared/usage';
import { UsageGauges, useUsageClock } from './UsageGauge';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MAX_AGENTS,
  WORKING_STATES,
  type Agent,
  type CliDefinition,
  type Workspace,
} from '../../shared/model';
import { agentName } from '../../shared/agent-name';
import { agentColor } from '../../shared/agent-color';
import type { DeliveryAction, TileMenu } from '../tiles/TileActions';
import { isFinalState, type DeliverySettings } from '../../shared/delivery';
import type { OrchestratorAction } from '../../shared/orchestrator';
import { agentRows } from '../../shared/agents-view';
import { deriveTodos } from '../../shared/todo';
import { Toolbar, type WorkspaceViewMode } from '../app/Toolbar';
import { FocusView, type FocusTab } from '../focus/FocusView';
import { ReportsTab, type Report } from '../focus/ReportsTab';
import { PreviewTab, type PreviewApi } from '../focus/PreviewTab';
import { ChangesTab } from '../review/ChangesTab';
import { ConflictsTab } from '../review/ConflictsTab';
import { DecisionColumn } from '../review/DecisionColumn';
import { IntegrationColumn } from '../review/IntegrationColumn';
import {
  seenBlob,
  type FileDiff,
  type Integration,
  type ReviewSnapshot,
  type TestRun,
} from '../../shared/review';
import type { ConflictAnswer, Decision, IntegrateRequest } from '../store/review-store';
import type { ReviewSendKind } from '../store/app-store';
import { FreeTerminalTile } from '../tiles/FreeTerminalTile';
import { Tile } from '../tiles/Tile';
import { TileGrid } from '../tiles/TileGrid';
import { AgentsColumn } from '../agents/AgentsColumn';
import { GraphView } from '../graph/GraphView';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { DeliveryBar } from '../delivery/DeliveryBar';
import { EmptyWorkspace } from './EmptyWorkspace';

/** The tile actions, each about one agent (FR-024, FR-037). */
export type AgentActions = {
  /** `always`: « Toujours pour ce worktree », from the Focus (FR-034). */
  onAnswer: (agentId: string, answer: 'allow' | 'deny', always?: boolean) => void;
  onResume: (agentId: string) => void;
  onRestart: (agentId: string) => void;
  onLog: (agentId: string) => void;
  /** « Annuler » of « reprise auto à HH:MM » (FR-036). */
  onCancelAutoResume: (agentId: string) => void;
  onClose: (agentId: string) => void;
  /** « Revue → »: opens the Changements tab of the agent (002 FR-002). */
  onReview?: (agentId: string) => void;
  /** 008 — « Fusionner » / « Refuser » of the merge the user is asked for, on the head shown. */
  onDecideDelivery?: (deliveryId: string, decision: 'validate' | 'refuse', head: string) => void;
  /** 008 — « Livrer » / « Intégrer » of an agent. */
  onRequestDelivery?: (
    agentId: string,
    request: { title: string; message: string; unverified: boolean },
  ) => void;
  /** 008 FR-019 — the settings of the delivery of the project that changed (« Auto » first). */
  onDeliverySettings?: (settings: Partial<DeliverySettings>) => void;
  /** 004 FR-018 — the user's decision on a loop stopped after 3 rounds. */
  onDecideLoop?: (issueId: string, decision: 'restart' | 'take-over' | 'abandon') => void;
  /** 007 FR-006 — the user's decision on two agents that bounce a message. */
  onDecideExchange?: ((escalationId: string, decision: 'resume' | 'cut') => void) | undefined;
  /** 004 FR-023 — « Créer » / « Refuser » of the issues the orchestrator asks to publish. */
  onConfirmPublish?: (requestId: string) => void;
  onRefusePublish?: (requestId: string) => void;
  /** 006 US5 — « Faire orchestrateur » of the ⋮ menu, once confirmed. */
  onPromote?: (agentId: string) => void;
  /** 006 #45 — « Renommer » of the ⋮ menu. */
  onRename?: (agentId: string, name: string) => void;
  /** « Répondre dans le terminal ↗ »: opens the Focus on the agent's terminal (FR-024a). */
  onOpenTerminal?: (agentId: string) => void;
  /** « ◆ Décider »: the answer of the user to an agent stopped with questions, as a prompt. */
  onDecide?: (agentId: string, text: string) => void;
  /** 005 — « Détail » of a usage alert: opens the detail of its gauge (`usage:<cli>:<account>`). */
  onUsageDetail?: (key: string) => void;
};

/** The review of the app (review-store and « vu » of app-store), for this workspace. */
export type ReviewBinding = {
  /** The agents of this workspace with changes to review. */
  pending: readonly string[];
  /** Their number of changed files (the title of the À faire item); absent: unknown. */
  files?: Readonly<Record<string, number>>;
  snapshot: ReviewSnapshot | null;
  selected: string | null;
  diff: FileDiff | null;
  error: string | null;
  open: (agentId: string) => void;
  close: () => void;
  select: (path: string) => void;
  markSeen: (agentId: string, path: string, blob: string | null) => void;
  /** The Décision column (002 US2): tests and integration, per agent. */
  tests: Readonly<Record<string, TestRun>>;
  decisions: Readonly<Record<string, Decision>>;
  /** « ✓ Intégré · branche → main » for this workspace, until dismissed. */
  notice: string | null;
  runTests: (agentId: string) => void;
  cancelTests: (agentId: string) => void;
  setTestCommand: (agentId: string, command: string) => void;
  integrate: (
    agentId: string,
    request: IntegrateRequest,
    label: { branch: string; mainBranch: string },
  ) => void;
  dismissNotice: () => void;
  /** A comment on one line of the diff, sent to the agent (002 US3). */
  comment: (agentId: string, path: string, line: number, text: string) => void;
  /** A shortcut, or « Renvoyer à l'agent » with its text. */
  send: (agentId: string, kind: ReviewSendKind, text?: string) => void;
  /** The agents still on what the review sent them (« Agent : correction en cours »). */
  correcting: Readonly<Record<string, 'queued' | 'working'>>;
  /** The integrations stopped on a conflict, per agent (screen 1q, 002 US4). */
  integrations: Readonly<Record<string, Integration>>;
  resolveConflict: (agentId: string, path: string, answer: ConflictAnswer) => void;
  openInEditor: (agentId: string, path: string) => void;
  askAgent: (agentId: string) => void;
  finishIntegration: (agentId: string, label: { branch: string; mainBranch: string }) => void;
  cancelIntegration: (agentId: string) => void;
};

/** How long « ✓ Intégré » stays (US2/AC6). */
const NOTICE_MS = 4000;

const none = () => undefined;
const NO_ACTIONS: AgentActions = {
  onAnswer: none,
  onResume: none,
  onRestart: none,
  onLog: none,
  onCancelAutoResume: none,
  onClose: none,
};

type Props = {
  workspace: Workspace;
  clis?: CliDefinition[];
  /** Where the tiles find their terminals; without it, tiles show no terminal. */
  terminals?: Pick<TerminalRegistry, 'attach'> | undefined;
  onAddAgents?: () => void;
  actions?: AgentActions;
  /** Why the last tile action was refused. */
  actionError?: string | null;
  /** The place the tab bar keeps for the views (1b); without it they sit above the tiles. */
  toolbarSlot?: HTMLElement | null;
  /** A clicked notification: the view goes to this agent (a new object each click). */
  focusRequest?: { workspaceId: string; agentId: string } | null;
  /** 005 — the usage of every CLI account read so far. */
  usage?: readonly UsageState[];
  /** 005 FR-010 — the alert thresholds of the gauges, and their change. */
  usageThresholds?: UsageThresholds;
  onUsageThresholds?: (thresholds: UsageThresholds) => void;
  /** Without it, the Changements tab stays empty and no « Revue → » is offered. */
  review?: ReviewBinding | undefined;
  /** 003 FR-010 — the agents working on a prompt of the orchestrator. */
  fromOrchestrator?: Readonly<Record<string, unknown>>;
  /** 004 US2 — what the loops of this workspace told, for the orchestrator's « Rapports ». */
  loopReports?: readonly Report[];
  /** 003 US5 — the journal « ◎ Actions » of the orchestrator and the withdrawal of its role. */
  orchestration?: OrchestrationBinding | undefined;
  /** 004 US4 — the Aperçu of the agent in Focus; without it, the tab stays disabled. */
  preview?: PreviewApi | undefined;
};

export type OrchestrationBinding = {
  actions: Readonly<Record<string, OrchestratorAction[]>>;
  load: (agentId: string) => void;
  revoke: (agentId: string) => void;
};

const ALERT =
  'm-0 rounded-xl border border-destructive/40 bg-destructive/8 px-3.5 py-3 text-[13px]';

export function WorkspaceView({
  workspace,
  clis = [],
  terminals,
  onAddAgents,
  actions = NO_ACTIONS,
  actionError = null,
  toolbarSlot = null,
  usage = [],
  usageThresholds,
  onUsageThresholds,
  review,
  fromOrchestrator = {},
  loopReports = [],
  orchestration,
  preview,
  focusRequest,
}: Props) {
  const available = workspace.status === 'available';
  const launch = available ? onAddAgents : undefined;
  const hasAgents = workspace.agents.length > 0;
  const hasTiles = hasAgents || workspace.freeTerminals.length > 0;
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  const cliName = (id: string) => clis.find((cli) => cli.id === id)?.name ?? id;
  const canAdd = agents.length < MAX_AGENTS;
  const [todoOpen, setTodoOpen] = useState(true);
  // A closed agent may still be in the last review:pending: only the agents here count.
  const pending = (review?.pending ?? []).filter((id) => agents.some((agent) => agent.id === id));
  const now = useUsageClock(usage);
  const [usageDetail, setUsageDetail] = useState<string | null>(null);
  const todos = deriveTodos(
    workspace,
    cliName,
    Object.fromEntries(pending.map((id) => [id, review?.files?.[id] ?? 0])),
    usageThresholds && { states: usage, thresholds: usageThresholds, now },
  );
  const agentsView = agentRows(workspace, todos, cliName, now);
  // Focus (1p) on one agent; back to the grid when that agent is closed (US5).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusTab, setFocusTab] = useState<FocusTab>('terminal');
  /** The Revue view: the Focus goes from one agent to review to the next (FR-003). */
  const [reviewView, setReviewView] = useState(false);
  /** 006 US3 — the Graphe view, until an agent is opened or the tiles come back. */
  const [graphView, setGraphView] = useState(false);
  const focused = agents.some((agent) => agent.id === focusedId) ? focusedId : null;
  // Screen 1q of the agent in Focus, while its integration is stopped on a conflict (FR-027).
  const integration = (focused !== null && review?.integrations[focused]) || null;
  const tab = focusTab === 'conflicts' && !integration ? 'changes' : focusTab;
  const reviewed = focused !== null && (tab === 'changes' || tab === 'conflicts') ? focused : null;
  const focusedAgent = agents.find((agent) => agent.id === focused);
  const focusedLead = focusedAgent?.role === 'orchestrator' ? focusedAgent.id : null;
  // Back to the terminal once the role is gone: the journal belongs to an orchestrator.
  if (
    (focusTab === 'actions' || focusTab === 'reports') &&
    focusedLead === null &&
    focused !== null
  ) {
    setFocusTab('terminal');
  }

  const loader = useRef(orchestration?.load);
  useLayoutEffect(() => {
    loader.current = orchestration?.load;
  });
  const journalOf = tab === 'actions' ? focusedLead : null;
  useEffect(() => {
    if (journalOf !== null) loader.current?.(journalOf);
  }, [journalOf]);
  const reviewedAgent = agents.find((agent) => agent.id === reviewed);
  // #43 — Changements is offered once the agent has files to review.
  const changedFilesOf = (agentId: string) =>
    review?.snapshot?.agentId === agentId
      ? review.snapshot.files.length
      : (review?.files?.[agentId] ?? (review?.pending.includes(agentId) ? 1 : 0));

  // The conflict screen opens by itself once « Intégrer » meets a conflict.
  const conflictId = integration?.state === 'conflicted' ? integration.id : null;
  const [shownConflict, setShownConflict] = useState<string | null>(null);
  if (conflictId !== shownConflict) {
    setShownConflict(conflictId);
    if (conflictId !== null && focusTab === 'changes') setFocusTab('conflicts');
  }

  // The main process follows the worktree of the agent reviewed, and only while it is (R3).
  const binding = useRef(review);
  useLayoutEffect(() => {
    binding.current = review;
  });
  useEffect(() => {
    if (reviewed === null) return;
    binding.current?.open(reviewed);
    return () => {
      binding.current?.close();
    };
  }, [reviewed]);

  // Once integrated, back to the tiles, where the notice shows for a while (US2/AC6).
  const notice = review?.notice ?? null;
  const [noticed, setNoticed] = useState(notice);
  if (notice !== noticed) {
    setNoticed(notice);
    if (notice !== null) {
      setFocusedId(null);
      setFocusTab('terminal');
      setReviewView(false);
    }
  }
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => binding.current?.dismissNotice(), NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const openReview = (agentId: string) => {
    setFocusedId(agentId);
    setFocusTab(review?.integrations[agentId] ? 'conflicts' : 'changes');
  };
  const openTerminal = (agentId: string) => {
    setReviewView(false);
    setGraphView(false);
    setFocusedId(agentId);
    setFocusTab('terminal');
  };
  // A clicked notification moves the view once, to the terminal of its agent.
  const [seenFocus, setSeenFocus] = useState(focusRequest);
  if (focusRequest !== seenFocus) {
    setSeenFocus(focusRequest);
    if (
      focusRequest?.workspaceId === workspace.id &&
      agents.some((agent) => agent.id === focusRequest.agentId)
    ) {
      openTerminal(focusRequest.agentId);
    }
  }
  const reviewActions: AgentActions = {
    ...actions,
    onReview: openReview,
    onOpenTerminal: openTerminal,
    onUsageDetail: setUsageDetail,
    ...(review && {
      onDecide: (agentId: string, text: string) => {
        review.send(agentId, 'request', text);
      },
    }),
  };
  const backToTiles = () => {
    setFocusedId(null);
    setFocusTab('terminal');
    setReviewView(false);
    setGraphView(false);
  };
  const changeView = (next: WorkspaceViewMode) => {
    if (next === 'tiles') {
      backToTiles();
      return;
    }
    if (next === 'graph') {
      setFocusedId(null);
      setFocusTab('terminal');
      setReviewView(false);
      setGraphView(true);
      return;
    }
    // Revue is only enabled with an agent to review: the view opens on the first one.
    for (const first of agents.filter((agent) => pending.includes(agent.id)).slice(0, 1)) {
      setReviewView(true);
      openReview(first.id);
    }
  };
  const inReview = reviewView && focused !== null;
  const graphShown = graphView && hasAgents && focused === null;
  const pills = inReview
    ? agents.filter((agent) => pending.includes(agent.id) || agent.id === focused)
    : agents;
  const snapshot = review?.snapshot?.agentId === reviewed ? review.snapshot : null;

  // 003 R10 — the orchestrator, if any, leads the tiles from the top.
  const lead = agents.find((agent) => agent.role === 'orchestrator');
  // 004 US2 — « tour N/3 » on the dev and the test of a running loop.
  const roundOf = (agentId: string) =>
    workspace.loops.find(
      (l) => l.state === 'running' && (l.devAgentId === agentId || l.testAgentId === agentId),
    )?.round ?? null;
  // 008 — « Livrer » / « Intégrer » on the dev, or the lone agent, that is not already delivering.
  const deliveryOf = (agent: Agent): DeliveryAction | undefined => {
    const { onRequestDelivery } = actions;
    if (!onRequestDelivery || agent.role === 'orchestrator' || agent.role === 'test') {
      return undefined;
    }
    if (workspace.deliveries.some((d) => d.agentId === agent.id && !isFinalState(d.state))) {
      return undefined;
    }
    const loop = workspace.loops.find((l) => l.devAgentId === agent.id && l.state === 'accepted');
    const issue = loop && workspace.issues.find((i) => i.id === loop.issueId);
    return {
      remote: workspace.hasOrigin === true,
      accepted: loop !== undefined,
      title: issue?.title ?? agent.branch,
      onRequest: (request) => {
        onRequestDelivery(agent.id, request);
      },
    };
  };
  // 006 — the ⋮ menu of a tile and of the Focus: « Faire orchestrateur » (US5), « Renommer » (#45).
  const menuOf = (agent: Agent): TileMenu => {
    const { onPromote, onRename } = actions;
    const canBe = clis.find((cli) => cli.id === agent.cliId)?.orchestrator;
    const reason =
      lead && lead.id !== agent.id
        ? `${agentName(lead, cliName)} est déjà l’orchestrateur`
        : canBe === false
          ? 'Ce CLI ne sait pas être orchestrateur'
          : agent.state === 'closed'
            ? 'L’agent est fermé'
            : null;
    return {
      promote:
        onPromote && agent.role !== 'orchestrator'
          ? {
              reason,
              working: WORKING_STATES.includes(agent.state),
              onConfirm: () => {
                onPromote(agent.id);
              },
            }
          : undefined,
      rename: onRename
        ? {
            name: agentName(agent, cliName),
            onRename: (next) => {
              onRename(agent.id, next);
            },
          }
        : undefined,
    };
  };
  const tileOf = (agent: Agent) => (
    <Tile
      key={agent.id}
      menu={menuOf(agent)}
      delivery={deliveryOf(agent)}
      color={agentColor(agent, agents)}
      fromOrchestrator={fromOrchestrator[agent.id] !== undefined}
      round={roundOf(agent.id)}
      reports={loopReports}
      agent={agent}
      name={cliName(agent.cliId)}
      terminals={terminals}
      onAnswer={(answer) => {
        actions.onAnswer(agent.id, answer);
      }}
      onResume={() => {
        actions.onResume(agent.id);
      }}
      onRestart={() => {
        actions.onRestart(agent.id);
      }}
      onLog={() => {
        actions.onLog(agent.id);
      }}
      onCancelAutoResume={() => {
        actions.onCancelAutoResume(agent.id);
      }}
      onClose={() => {
        actions.onClose(agent.id);
      }}
      onExpand={() => {
        setFocusedId(agent.id);
      }}
      onOpenTerminal={() => {
        openTerminal(agent.id);
      }}
      onReview={
        review && pending.includes(agent.id)
          ? () => {
              openReview(agent.id);
            }
          : undefined
      }
    />
  );

  // The À faire column and its button appear with the first agent (FR-006).
  const toolbar = (
    <Toolbar
      todoCount={agentsView.pendingCount}
      showTodo={hasAgents}
      todoOpen={todoOpen}
      onToggleTodo={() => {
        setTodoOpen((open) => !open);
      }}
      onAddAgents={launch}
      reviewCount={review ? pending.length : 0}
      view={inReview ? 'review' : graphShown ? 'graph' : 'tiles'}
      onView={changeView}
      usage={
        <UsageGauges
          workspace={workspace}
          usage={usage}
          clis={clis}
          now={now}
          detail={usageDetail}
          onDetail={setUsageDetail}
          {...(usageThresholds && { thresholds: usageThresholds })}
          {...(onUsageThresholds && { onThresholds: onUsageThresholds })}
        />
      }
    />
  );

  return (
    <>
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}
      <div className="flex h-full min-h-0">
        <section
          aria-label={workspace.name}
          className="flex h-full min-w-0 flex-1 flex-col gap-3 p-3.5"
        >
          {!available && (
            <p role="alert" className={ALERT}>
              Dossier introuvable : {workspace.path}. Le workspace reviendra dès que le dossier sera
              de retour.
            </p>
          )}
          {notice !== null && (
            <p
              role="status"
              className="m-0 self-center rounded-full border border-accept/30 bg-accept/10 px-3.5 py-1.5 text-[12.5px] text-accept"
            >
              {notice}
            </p>
          )}
          {actionError && (
            <p role="alert" className={ALERT}>
              {actionError}
            </p>
          )}
          {available && !hasTiles && <EmptyWorkspace onAddAgents={launch} />}
          {available && focused && (
            <FocusView
              agents={agents}
              agentId={focused}
              name={cliName}
              terminals={terminals}
              pills={pills}
              menu={focusedAgent && menuOf(focusedAgent)}
              delivery={focusedAgent && deliveryOf(focusedAgent)}
              changedFiles={changedFilesOf(focused)}
              onSelect={(agentId) => {
                if (inReview) openReview(agentId);
                else setFocusedId(agentId);
              }}
              onBack={backToTiles}
              tab={tab}
              onTab={setFocusTab}
              orchestration={
                focusedLead !== null && orchestration
                  ? {
                      actions: orchestration.actions[focusedLead] ?? [],
                      messages: workspace.exchanges.messages,
                      onRevoke: () => {
                        orchestration.revoke(focusedLead);
                      },
                    }
                  : undefined
              }
              preview={
                preview ? <PreviewTab key={focused} agentId={focused} api={preview} /> : undefined
              }
              reports={
                focusedLead !== null ? (
                  <ReportsTab
                    reports={loopReports}
                    agents={agents}
                    loops={workspace.loops}
                    name={cliName}
                  />
                ) : undefined
              }
              conflicts={
                integration && review
                  ? {
                      count: integration.conflicts.length,
                      content: (
                        <ConflictsTab
                          integration={integration}
                          mainBranch={workspace.mainBranch}
                          clean={Math.max(
                            0,
                            (snapshot?.files.length ?? 0) - integration.conflicts.length,
                          )}
                          onResolve={(path, hunk, choice) => {
                            review.resolveConflict(integration.agentId, path, { hunk, choice });
                          }}
                          onEdit={(path, content) => {
                            review.resolveConflict(integration.agentId, path, { content });
                          }}
                          onOpenInEditor={(path) => {
                            review.openInEditor(integration.agentId, path);
                          }}
                        />
                      ),
                    }
                  : undefined
              }
              changes={
                reviewedAgent && (
                  <ChangesTab
                    snapshot={snapshot}
                    seen={reviewedAgent.review.seen}
                    selected={snapshot ? (review?.selected ?? null) : null}
                    diff={snapshot ? (review?.diff ?? null) : null}
                    error={review?.error ?? null}
                    onSelect={(path) => review?.select(path)}
                    onSeen={(file, seen) =>
                      review?.markSeen(reviewedAgent.id, file.path, seen ? seenBlob(file) : null)
                    }
                    comments={reviewedAgent.review.comments}
                    tests={review?.tests[reviewedAgent.id] ?? null}
                    mainBranch={workspace.mainBranch}
                    {...(review && {
                      onComment: (path: string, line: number, text: string) => {
                        review.comment(reviewedAgent.id, path, line, text);
                      },
                      onSend: (kind: ReviewSendKind) => {
                        review.send(reviewedAgent.id, kind);
                      },
                    })}
                  />
                )
              }
              {...actions}
            />
          )}
          {available && graphShown && (
            <GraphView
              agents={agents}
              loops={workspace.loops}
              names={cliName}
              now={now}
              onOpen={openTerminal}
            />
          )}
          {available && hasTiles && !focused && !graphShown && (
            <TileGrid onAdd={canAdd ? launch : undefined} lead={lead ? tileOf(lead) : undefined}>
              {agents.filter((agent) => agent !== lead).map(tileOf)}
              {workspace.freeTerminals.map((terminal) => (
                <FreeTerminalTile key={terminal.id} terminal={terminal} terminals={terminals} />
              ))}
            </TileGrid>
          )}
          {available && (
            <DeliveryBar
              auto={workspace.delivery.auto}
              hasOrigin={workspace.hasOrigin === true}
              onToggleAuto={(auto) => {
                actions.onDeliverySettings?.({ auto });
              }}
            />
          )}
        </section>
        {/* Décision takes the place of À faire while a review is open (FR-004), and Intégration
            the place of Décision while its integration is stopped on a conflict (1q). */}
        {reviewedAgent && review && integration ? (
          <IntegrationColumn
            integration={integration}
            agent={reviewedAgent}
            agentName={cliName(reviewedAgent.cliId)}
            snapshot={snapshot}
            tests={review.tests[reviewedAgent.id] ?? null}
            mainBranch={workspace.mainBranch}
            busy={review.decisions[reviewedAgent.id]?.busy ?? false}
            error={review.decisions[reviewedAgent.id]?.error ?? null}
            onAskAgent={() => {
              review.askAgent(reviewedAgent.id);
            }}
            onFinish={() => {
              review.finishIntegration(reviewedAgent.id, {
                branch: reviewedAgent.branch,
                mainBranch: workspace.mainBranch,
              });
            }}
            onCancel={() => {
              review.cancelIntegration(reviewedAgent.id);
              setFocusTab('changes');
            }}
            onRunTests={() => {
              review.runTests(reviewedAgent.id);
            }}
            onCancelTests={() => {
              review.cancelTests(reviewedAgent.id);
            }}
            onSetTestCommand={(command) => {
              review.setTestCommand(reviewedAgent.id, command);
            }}
          />
        ) : reviewedAgent && review ? (
          <DecisionColumn
            agent={reviewedAgent}
            snapshot={snapshot}
            mainBranch={workspace.mainBranch}
            tests={review.tests[reviewedAgent.id] ?? null}
            busy={review.decisions[reviewedAgent.id]?.busy ?? false}
            error={review.decisions[reviewedAgent.id]?.error ?? null}
            onRunTests={() => {
              review.runTests(reviewedAgent.id);
            }}
            onCancelTests={() => {
              review.cancelTests(reviewedAgent.id);
            }}
            onSetTestCommand={(command) => {
              review.setTestCommand(reviewedAgent.id, command);
            }}
            onIntegrate={(request) => {
              review.integrate(reviewedAgent.id, request, {
                branch: reviewedAgent.branch,
                mainBranch: workspace.mainBranch,
              });
            }}
            onSendBack={(text) => {
              review.send(reviewedAgent.id, 'request', text);
              // FR-015: the agent works on it, the tiles show it.
              backToTiles();
            }}
            sent={review.correcting[reviewedAgent.id] !== undefined}
            onAbandon={() => {
              actions.onClose(reviewedAgent.id);
            }}
          />
        ) : (
          hasAgents &&
          todoOpen && <AgentsColumn view={agentsView} onOpen={openTerminal} {...reviewActions} />
        )}
      </div>
    </>
  );
}
