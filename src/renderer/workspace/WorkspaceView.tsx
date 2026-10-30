import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_AGENTS, type CliDefinition, type Workspace } from '../../shared/model';
import { deriveTodos } from '../../shared/todo';
import { Toolbar, type WorkspaceViewMode } from '../app/Toolbar';
import { FocusView, type FocusTab } from '../focus/FocusView';
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
import { TodoColumn } from '../todo/TodoColumn';
import type { TerminalRegistry } from '../tiles/terminal-registry';
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
};

/** The review of the app (review-store and « vu » of app-store), for this workspace. */
export type ReviewBinding = {
  /** The agents of this workspace with changes to review. */
  pending: readonly string[];
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
  /** Without it, the Changements tab stays empty and no « Revue → » is offered. */
  review?: ReviewBinding | undefined;
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
  review,
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
  const todos = deriveTodos(workspace, cliName, pending);
  // Focus (1p) on one agent; back to the grid when that agent is closed (US5).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusTab, setFocusTab] = useState<FocusTab>('terminal');
  /** The Revue view: the Focus goes from one agent to review to the next (FR-003). */
  const [reviewView, setReviewView] = useState(false);
  const focused = agents.some((agent) => agent.id === focusedId) ? focusedId : null;
  // Screen 1q of the agent in Focus, while its integration is stopped on a conflict (FR-027).
  const integration = (focused !== null && review?.integrations[focused]) || null;
  const tab = focusTab === 'conflicts' && !integration ? 'changes' : focusTab;
  const reviewed = focused !== null && tab !== 'terminal' ? focused : null;
  const reviewedAgent = agents.find((agent) => agent.id === reviewed);

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
  const reviewActions: AgentActions = { ...actions, onReview: openReview };
  const backToTiles = () => {
    setFocusedId(null);
    setFocusTab('terminal');
    setReviewView(false);
  };
  const changeView = (next: WorkspaceViewMode) => {
    if (next === 'tiles') {
      backToTiles();
      return;
    }
    const first = agents.find((agent) => pending.includes(agent.id));
    if (!first) return;
    setReviewView(true);
    openReview(first.id);
  };
  const inReview = reviewView && focused !== null;
  const pills = inReview
    ? agents.filter((agent) => pending.includes(agent.id) || agent.id === focused)
    : agents;
  const snapshot = review?.snapshot?.agentId === reviewed ? review.snapshot : null;

  // The À faire column and its button appear with the first agent (FR-006).
  const toolbar = (
    <Toolbar
      todoCount={todos.filter((todo) => todo.kind !== 'info').length}
      showTodo={hasAgents}
      todoOpen={todoOpen}
      onToggleTodo={() => {
        setTodoOpen((open) => !open);
      }}
      onAddAgents={launch}
      reviewCount={review ? pending.length : 0}
      view={inReview ? 'review' : 'tiles'}
      onView={changeView}
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
              onSelect={(agentId) => {
                if (inReview) openReview(agentId);
                else setFocusedId(agentId);
              }}
              onBack={backToTiles}
              tab={tab}
              onTab={setFocusTab}
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
          {available && hasTiles && !focused && (
            <TileGrid onAdd={canAdd ? launch : undefined}>
              {agents.map((agent) => (
                <Tile
                  key={agent.id}
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
                  onReview={
                    review && pending.includes(agent.id)
                      ? () => {
                          openReview(agent.id);
                        }
                      : undefined
                  }
                />
              ))}
              {workspace.freeTerminals.map((terminal) => (
                <FreeTerminalTile key={terminal.id} terminal={terminal} terminals={terminals} />
              ))}
            </TileGrid>
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
          hasAgents && todoOpen && <TodoColumn todos={todos} agents={agents} {...reviewActions} />
        )}
      </div>
    </>
  );
}
