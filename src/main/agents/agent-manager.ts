import { within } from '../timeout';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { draftRole, IpcFailure, type AgentDraft, type IpcEvent } from '../../shared/ipc';
import { freeColors, freePositions } from '../../shared/launch-draft';
import {
  MAX_AGENTS,
  WORKING_STATES,
  type Agent,
  type CliDefinition,
  type ScheduledResume,
  type Workspace,
} from '../../shared/model';
import { agentsLaunchedBy } from '../../shared/agents-view';
import { profilesOf } from '../../shared/roles';
import type { GitService } from '../git/git-service';
import { allocatePort, isPortInUse as defaultIsPortInUse } from '../ports/port-allocator';
import type { PtyManager } from '../pty/pty-manager';
import { IDLE_QUESTION_MS } from './adapters/generic';
import type {
  AgentMcpLaunch,
  AgentSignal,
  CliAdapter,
  OrchestratorLaunch,
  ResolvedEnv,
} from './adapters/types';
import { applyExit, applySignal } from './agent-state';
import { AutoResume, type Clock } from './auto-resume';
import { BranchWatcher } from './branch-watcher';
import type { RegisteredCli } from './cli-registry';
import type { HookServer } from './hook-server';
import { TerminalText } from './terminal-text';
import { accountOf, type UsageSource } from '../usage/usage-service';
import {
  ROLE_FILE,
  ROLE_FILE_PROMPT,
  writeRoleFile,
  type RoleSkills,
} from '../orchestrator/role-skills';

// US2 — agents launched in their own worktree and pseudo-terminal, followed through their hooks
// (FR-009…FR-018, FR-038, FR-039). US3 — the tile actions: answer, resume, restart, log, close
// (FR-024, FR-037), and the branch followed for the ⎇ tooltip (FR-021).

export type AgentStateEvent = IpcEvent<'agent:state'>;
export type AgentBranchEvent = IpcEvent<'agent:branch'>;

type WorkspaceAccess = {
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

type Options = {
  workspaces: WorkspaceAccess;
  registry: {
    get(id: string): RegisteredCli | undefined;
    /** 004 — every CLI, for the default role profiles. */
    list(): CliDefinition[];
  };
  git: Pick<
    GitService,
    | 'addWorktree'
    | 'branchExists'
    | 'currentBranch'
    | 'removeWorktree'
    | 'fetchOrigin'
    | 'remoteBranchExists'
  > &
    Partial<Pick<GitService, 'exclude'>>;
  pty: PtyManager;
  hooks: Pick<HookServer, 'register' | 'unregister'>;
  /** Base URL of the hook server, known once it listens. */
  hookUrl: () => string;
  resolveEnv: () => Promise<ResolvedEnv>;
  /** A launch waits this long for the fetch of origin/<main>, then goes on with the last known. */
  fetchTimeoutMs?: number;
  isPortInUse?: (port: number) => Promise<boolean>;
  onState?: (event: AgentStateEvent) => void;
  onBranch?: (event: AgentBranchEvent) => void;
  /** Agents were launched, whoever asked: the launcher or an orchestrator. */
  onLaunched?: (workspaceId: string, agents: Agent[]) => void;
  /** Quiet time after which the output is read again for a question (generic adapter). */
  idleMs?: number;
  /** Whether a rate limit in this workspace is resumed without asking (FR-035); off by default. */
  autoResume?: (workspaceId: string) => Promise<boolean>;
  clock?: Clock;
  /**
   * The agent is closing: what follows its worktree lets go of it first, since on Windows a
   * folder watched cannot be removed (002 FR-024).
   */
  onClosing?: (agentId: string) => void;
  /**
   * fix-send-prompt — pause between a typed prompt and its Enter. Claude Code swallows an Enter
   * glued to the end of a paste; 150 ms is long enough for it to have taken the paste in, short
   * enough to be unnoticeable.
   */
  submitDelayMs?: number;
  /**
   * fix-send-prompt — how long the agent may stay ready after the Enter before PACT presses it
   * once more, then gives the prompt up as undelivered. 5 s covers a slow CLI turning to
   * « working » (its hook goes through a network round trip) without leaving a lost Enter long.
   */
  submitTimeoutMs?: number;
  /** 003 R4 — a prompt was typed into the agent, with where it came from. */
  onPromptTyped?: (agentId: string, origin: PromptOrigin) => void;
  /** 003 — the session plugin and token of an orchestrator, prepared before each start (R2). */
  orchestrator?: {
    prepare(agent: Agent): Promise<OrchestratorLaunch>;
    /** 004 R5 — the MCP access of an agent with another role. */
    prepareAgent?(agent: Agent): Promise<AgentMcpLaunch>;
    release(agentId: string): void;
  };
  /** 005 R1, R2 — where the usage the agents' CLIs report goes. */
  usage?: {
    statusLine(source: UsageSource, payload: unknown): string;
    follow(source: UsageSource, rollout: { codexHome: string; sessionId: string }): void;
    release(agentId: string): void;
    /** 005 R8 — the reset the gauge knows, for a rate limit whose message gives none. */
    resetAt?(cliId: string, account: string): Date | undefined;
  };
};

/** Who asked for a prompt: the review (002) or the orchestrator of the workspace (003 R4). */
export type PromptOrigin = 'review' | 'orchestrator' | 'resume';

type QueuedPrompt = { text: string; origin: PromptOrigin };

/** A prompt typed and waiting for the agent to leave the ready state (fix-send-prompt). */
type Submission = { origin: PromptOrigin; timer: ReturnType<typeof setTimeout> };

/** What a start carries for the role of the agent (003 R2, 004 R3). */
type Prepared = {
  orchestrator: OrchestratorLaunch | null;
  agentMcp: AgentMcpLaunch | null;
  skills: RoleSkills | null;
};

export type LaunchRequest = {
  workspaceId: string;
  agents: AgentDraft[];
  counters: Workspace['quickLaunchCounters'];
  /** 006 R4 — the orchestrator that asks for the launch; absent: the user. */
  launchedBy?: string;
};

type Running = {
  workspaceId: string;
  adapter: CliAdapter;
  output: TerminalText;
  idle?: ReturnType<typeof setTimeout>;
  /** 004 R3 — typed into a generic CLI with a role at its first output, before anything else. */
  roleFilePrompt?: boolean;
  /** 005 — who reports the usage of this agent's CLI account, and where Codex writes. */
  usage?: { source: UsageSource; codexHome: string };
};
type InstalledCli = { adapter: CliAdapter; executablePath: string };

/** Set by the Claude Code session PACT may be started from; an agent must not inherit them. */
const isParentClaudeVariable = (name: string) =>
  name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** What the terminal sends for Shift+Enter (see xterm-factory). */
const LINE_BREAK = '\x1b\r';
const isReady = (state: Agent['state']) => state === 'awaiting-prompt' || state === 'done';

/** 006 FR-026 — typed to an agent that was at work when it was closed, once it is ready. */
export const RESUME_PROMPT =
  'PACT a relancé cette session après sa fermeture. Reprends le travail là où tu t’étais arrêté.';

const RESTORED_MESSAGE = 'PACT a redémarré : agent à reprendre.';
const UNAVAILABLE_MESSAGE = 'Dossier du workspace introuvable : agent arrêté.';

/** How long a launch waits for the fetch of origin/<main> (a slow remote must not block it). */
const FETCH_WAIT_MS = 5000;

export class AgentManager {
  private readonly workspaces: WorkspaceAccess;
  private readonly registry: Options['registry'];
  private readonly git: Options['git'];
  private readonly pty: PtyManager;
  private readonly hooks: Options['hooks'];
  private readonly hookUrl: () => string;
  private readonly resolveEnv: () => Promise<ResolvedEnv>;
  private readonly fetchTimeoutMs: number;
  private readonly isPortInUse: (port: number) => Promise<boolean>;
  private readonly onState: NonNullable<Options['onState']>;
  private readonly onBranch: NonNullable<Options['onBranch']>;
  private readonly onLaunched: NonNullable<Options['onLaunched']>;
  private readonly branches: BranchWatcher;
  private readonly idleMs: number;
  private readonly autoResumeOn: (workspaceId: string) => Promise<boolean>;
  private readonly resumes: AutoResume;
  private readonly orchestrator: Options['orchestrator'];
  private readonly usage: Options['usage'];
  private readonly running = new Map<string, Running>();
  /** The ruleKey of the request each agent waits on, for « Toujours pour ce worktree ». */
  private readonly pendingRule = new Map<string, string>();
  /**
   * Prompts waiting for the agent to be ready (002 R7): review comments and shortcuts. One is typed per ready transition.
   */
  private readonly prompts = new Map<string, QueuedPrompt[]>();
  /** 003 — the question each agent waits on, for the orchestrator's list_agents (FR-011). */
  private readonly questions = new Map<string, string>();
  private readonly onPromptTyped: NonNullable<Options['onPromptTyped']>;
  private readonly onClosing: NonNullable<Options['onClosing']>;
  /** Agents a prompt was typed to, until they leave the ready state. */
  private readonly promptTyped = new Set<string>();
  /** The prompt typed to each agent whose submission is not confirmed yet. */
  private readonly submissions = new Map<string, Submission>();
  /** Prompts given up after two Enters, per agent and origin (fix-send-prompt). */
  private readonly undelivered = new Map<string, Record<PromptOrigin, number>>();
  private readonly submitDelayMs: number;
  private readonly submitTimeoutMs: number;
  private readonly unsubscribe: (() => void)[];
  /** Launches run one at a time: each one reads the positions and ports the previous one took. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: Options) {
    this.workspaces = options.workspaces;
    this.registry = options.registry;
    this.git = options.git;
    this.pty = options.pty;
    this.hooks = options.hooks;
    this.hookUrl = options.hookUrl;
    this.resolveEnv = options.resolveEnv;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_WAIT_MS;
    this.isPortInUse = options.isPortInUse ?? defaultIsPortInUse;
    this.onState = options.onState ?? (() => undefined);
    this.onBranch = options.onBranch ?? (() => undefined);
    this.onLaunched = options.onLaunched ?? (() => undefined);
    this.onPromptTyped = options.onPromptTyped ?? (() => undefined);
    this.onClosing = options.onClosing ?? (() => undefined);
    this.idleMs = options.idleMs ?? IDLE_QUESTION_MS;
    this.submitDelayMs = options.submitDelayMs ?? 150;
    this.submitTimeoutMs = options.submitTimeoutMs ?? 5_000;
    this.autoResumeOn = options.autoResume ?? (() => Promise.resolve(false));
    this.orchestrator = options.orchestrator;
    this.usage = options.usage;
    this.resumes = new AutoResume({
      ...(options.clock ? { clock: options.clock } : {}),
      onDue: (resume) => void this.resumeDue(resume),
    });
    this.branches = new BranchWatcher({
      currentBranch: (path) => this.git.currentBranch(path),
      onBranch: (id, branch) => void this.renamed(id, branch),
    });
    this.unsubscribe = [
      this.pty.onData((id, data) => {
        this.readOutput(id, data);
      }),
      this.pty.onExit((id, code) => {
        void this.exited(id, code);
      }),
    ];
  }

  launch(request: LaunchRequest): Promise<Agent[]> {
    const run = this.queue.then(() => this.launchNow(request));
    this.queue = run.catch(() => undefined);
    void run.then(
      (agents) => {
        if (agents.length > 0) this.onLaunched(request.workspaceId, agents);
      },
      () => undefined,
    );
    return run;
  }

  /**
   * After a restart no agent process exists any more: live agents become « à reprendre »
   * (FR-038). A rate limit keeps its reason and its scheduled resume, armed again.
   */
  async restore(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    for (const agent of await this.markStale(workspace)) this.resumes.sync(agent);
  }

  /**
   * The folder of the workspace is gone (spec edge case, T121): its agents stop cleanly and wait,
   * marked, to be resumed once it is back.
   */
  async suspend(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.running]
        .filter(([, running]) => running.workspaceId === workspaceId)
        .map(([id]) => this.stop(id)),
    );
    // Read after the stops, so the agents are marked from their last saved state.
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) await this.markStale(workspace, UNAVAILABLE_MESSAGE);
  }

  /** The agents of the workspace, those without a process marked « à reprendre ». */
  private async markStale(
    { id: workspaceId, agents }: Workspace,
    message = RESTORED_MESSAGE,
  ): Promise<Agent[]> {
    const stale = (agent: Agent) =>
      agent.state !== 'closed' && agent.state !== 'error' && !this.pty.has(agent.id);
    const changed = agents.filter(stale);
    if (changed.length === 0) return agents;
    const updated = await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((agent) =>
        stale(agent)
          ? {
              ...agent,
              state: 'error' as const,
              lastError: { code: null, kind: 'crash' as const, message },
            }
          : agent,
      ),
    }));
    for (const agent of updated.agents) {
      if (changed.some((c) => c.id === agent.id)) this.emit(agent);
    }
    return updated.agents;
  }

  /**
   * « ✓ Autoriser » / « ✕ Refuser »: the keys the CLI expects, typed in its terminal.
   * « Toujours pour ce worktree » (`always`) also keeps the request's rule on the agent, so
   * later requests with the same ruleKey are allowed without asking (FR-034).
   */
  async answer(id: string, answer: 'allow' | 'deny', always = false): Promise<void> {
    const { workspace, agent } = this.find(id);
    const running = this.running.get(id);
    if (agent.state !== 'awaiting-answer' || !running) {
      throw new IpcFailure('INVALID_INPUT', 'Cet agent n’attend pas de réponse.');
    }
    // The keys of a permission would pick an option of the question blindly (FR-024a).
    if (agent.awaiting === 'question') {
      throw new IpcFailure(
        'INVALID_INPUT',
        'Répondez à cette question dans le terminal de l’agent.',
      );
    }
    const rule = always && answer === 'allow' ? this.pendingRule.get(id) : undefined;
    this.pendingRule.delete(id);
    this.pty.write(id, running.adapter.answerKeys(answer));
    await this.change(workspace.id, id, ({ awaiting: _answered, ...a }) => ({
      ...a,
      state: 'working',
      alwaysAllowRules:
        rule === undefined || a.alwaysAllowRules.includes(rule)
          ? a.alwaysAllowRules
          : [...a.alwaysAllowRules, rule],
    }));
  }

  /**
   * « Reprendre »: the same session (R6). A process still alive after a rate limit gets
   * « continue » typed in its prompt instead (data-model « AgentState »).
   */
  async resume(id: string): Promise<void> {
    const { workspace, agent } = this.inError(id);
    this.resumes.forget(id);
    await this.resumeNow(workspace, agent);
  }

  /** « Annuler » of « reprise auto à HH:MM »: the agent stays in error (FR-036). */
  async cancelAutoResume(id: string): Promise<void> {
    const { workspace } = this.find(id);
    this.resumes.forget(id);
    await this.change(workspace.id, id, (a) => ({ ...a, scheduledResume: null }));
  }

  /**
   * A line the user sends in the terminal is a manual action too: it replaces the scheduled resume
   * of CLIs without a prompt hook (FR-036). Free terminals are no agents: nothing to do.
   */
  typed(id: string, data: string): void {
    // Shift+Enter (ESC + CR) inserts a line break: it sends no line.
    if (data === LINE_BREAK || !data.includes('\r')) return;
    const found = this.workspaces
      .list()
      .flatMap((workspace) => workspace.agents)
      .find((agent) => agent.id === id);
    if (found?.scheduledResume) void this.cancelAutoResume(id);
  }

  /** « Relancer »: a new session. The initial prompt is not typed again: an agent that has one has
   * already begun, and the queued prompts (review, orchestrator) stay delivered in order. */
  async restart(id: string, options?: { resumeWork?: boolean }): Promise<void> {
    const { workspace, agent } = this.find(id);
    if (agent.state === 'closed') {
      await this.restartClosed(workspace, agent, options?.resumeWork === true);
      return;
    }
    this.inError(id);
    this.resumes.forget(id);
    await this.stop(id);
    await this.startAgain(workspace, agent, null);
  }

  /**
   * 006 FR-025, FR-026 — a closed agent starts again on its worktree, in its session; a closed
   * orchestrator brings back the agents closed with it, itself first. With `resumeWork`, those that
   * were at work get the resume prompt: queued, it is typed once the agent is ready.
   */
  private async restartClosed(workspace: Workspace, agent: Agent, resumeWork: boolean) {
    const group = [
      agent,
      ...(agent.role === 'orchestrator'
        ? agentsLaunchedBy(workspace, agent.id).filter((a) => a.state === 'closed')
        : []),
    ];
    for (const closed of group) {
      await this.startAgain(workspace, closed, closed.sessionId);
      if (resumeWork && closed.closedWhileWorking === true) {
        await this.sendPrompt(closed.id, RESUME_PROMPT, 'resume');
      }
    }
  }

  /**
   * 004 FR-007 — the third round of a loop on the role's ceiling: the same session again, on
   * `model`, so the agent keeps what it learnt in the first two rounds.
   */
  async escalate(id: string, model: string): Promise<void> {
    const { workspace, agent } = this.find(id);
    if (agent.model === model) return;
    await this.stop(id);
    const escalated = { ...agent, model };
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === id ? { ...a, model } : a)),
    }));
    await this.startAgain(workspace, escalated, agent.sessionId);
  }

  /**
   * 002 R7 — a prompt typed once the agent awaits one or is done, never while it works or waits
   * for an answer. Multi-line text goes as a bracketed paste, so it stays one prompt.
   */
  async sendPrompt(id: string, text: string, origin: PromptOrigin = 'review'): Promise<number> {
    await Promise.resolve();
    this.find(id);
    const item = { text, origin };
    this.prompts.set(id, [...(this.prompts.get(id) ?? []), item]);
    this.flushPrompt(id);
    // Where it waits: 0 when typed at once.
    return (this.prompts.get(id) ?? []).indexOf(item) + 1;
  }

  /** 003 — the prompts of `origin` still waiting for the agent (FR-011). */
  waitingPrompts(id: string, origin: PromptOrigin): number {
    return (this.prompts.get(id) ?? []).filter((item) => item.origin === origin).length;
  }

  /** fix-send-prompt — the prompts of `origin` typed to the agent but never submitted. */
  undeliveredPrompts(id: string, origin: PromptOrigin): number {
    return this.undelivered.get(id)?.[origin] ?? 0;
  }

  /** 003 FR-004 — the role is withdrawn: its prompts not typed yet are dropped. */
  cancelPrompts(id: string, origin: PromptOrigin): void {
    const kept = (this.prompts.get(id) ?? []).filter((item) => item.origin !== origin);
    if (kept.length === 0) this.prompts.delete(id);
    else this.prompts.set(id, kept);
  }

  /**
   * 003 FR-004 — « Retirer le rôle d'orchestrateur »: its token refused at once, its wait ended,
   * its prompts not typed yet dropped; the agent stays, as an ordinary one.
   */
  async revokeOrchestrator(id: string): Promise<void> {
    const { workspace, agent } = this.find(id);
    if (agent.role !== 'orchestrator') {
      throw new IpcFailure('INVALID_INPUT', 'Cet agent n’est pas l’orchestrateur.');
    }
    this.orchestrator?.release(id);
    for (const other of workspace.agents) this.cancelPrompts(other.id, 'orchestrator');
    await this.change(workspace.id, id, (a) => ({ ...a, role: null }));
  }

  /** 003 FR-011 — what the agent asks, while it waits for an answer. */
  questionOf(id: string): string | null {
    return this.questions.get(id) ?? null;
  }

  /** « Journal »: the output kept for the agent, across its restarts. */
  log(id: string): string {
    this.find(id);
    return this.pty.history(id);
  }

  /**
   * Stops the agent and forgets it; its worktree and branch go only when asked (FR-037). The
   * orchestrator closes the agents it launched with it (006 FR-023): the choice applies to all, and
   * kept, they stay in the workspace, closed, to be restarted with it (FR-025). Any other agent
   * closes alone (FR-024).
   */
  async close(id: string, { removeWorktree }: { removeWorktree: boolean }): Promise<void> {
    const { workspace, agent } = this.find(id);
    const launched = agent.role === 'orchestrator' ? agentsLaunchedBy(workspace, id) : [];
    // Closing what is closed already forgets it: that is how a closed tile goes.
    const keep = !removeWorktree && agent.state !== 'closed';
    for (const member of launched) await this.closeOne(member.id, removeWorktree, keep);
    // An orchestrator that launched nobody closes as any agent does.
    await this.closeOne(id, removeWorktree, keep && launched.length > 0);
  }

  private async closeOne(id: string, removeWorktree: boolean, keepTile: boolean) {
    const { workspace, agent } = this.find(id);
    // Closed with its orchestrator before: it stays as it is.
    if (keepTile && agent.state === 'closed') return;
    this.resumes.forget(id);
    this.prompts.delete(id);
    this.undelivered.delete(id);
    this.orchestrator?.release(id);
    this.onClosing(id);
    await this.stop(id);
    if (removeWorktree) {
      // The agent may have renamed its branch since the last check.
      const current = await this.git.currentBranch(agent.worktreePath).catch(() => '');
      await this.git.removeWorktree(workspace.path, {
        path: agent.worktreePath,
        branch: current || agent.branch,
        force: true,
      });
    }
    if (keepTile) {
      const closedWhileWorking = WORKING_STATES.includes(agent.state);
      await this.workspaces.update(workspace.id, (ws) => ({
        ...ws,
        agents: ws.agents.map((a) =>
          a.id === id
            ? {
                ...a,
                state: 'closed' as const,
                closedWhileWorking,
                lastError: null,
                scheduledResume: null,
                awaiting: undefined,
              }
            : a,
        ),
      }));
      this.emit({ ...agent, state: 'closed' }, true);
      return;
    }
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.filter((a) => a.id !== id),
    }));
    this.emit({ ...agent, state: 'closed' });
  }

  /** Agents whose process runs now; quitting asks first while there are some (T110). */
  activeCount(): number {
    return this.running.size;
  }

  /** Stops every agent process on quit; their last known state stays saved. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.unsubscribe) stop();
    this.branches.dispose();
    this.resumes.dispose();
    for (const { timer } of this.submissions.values()) clearTimeout(timer);
    this.submissions.clear();
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private find(id: string) {
    for (const workspace of this.workspaces.list()) {
      const agent = workspace.agents.find((a) => a.id === id);
      if (agent) return { workspace, agent };
    }
    throw new IpcFailure('NOT_FOUND', 'Agent inconnu.');
  }

  private inError(id: string) {
    const found = this.find(id);
    if (found.agent.state !== 'error') {
      throw new IpcFailure('INVALID_INPUT', 'Seul un agent en erreur se reprend ou se relance.');
    }
    return found;
  }

  /** Ends the process without it counting as a crash: PACT asked for it. */
  private async stop(id: string) {
    this.promptTyped.delete(id);
    this.clearSubmission(id);
    this.pendingRule.delete(id);
    this.branches.unwatch(id);
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.idle);
    this.running.delete(id);
    this.hooks.unregister(id);
    // 005 FR-014 — its part stays, closed; a Codex rollout is no longer followed.
    this.usage?.release(id);
    await this.pty.kill(id);
  }

  private async startAgain(workspace: Workspace, agent: Agent, sessionId: string | null) {
    const cli = this.installedCli(agent.cliId);
    const env = await this.resolveEnv();
    const fields = {
      state: 'starting',
      sessionId,
      lastError: null,
      scheduledResume: null,
      closedWhileWorking: false,
    } as const;
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === agent.id ? { ...a, ...fields } : a)),
    }));
    const started: Agent = { ...agent, ...fields };
    this.emit(started);
    this.resumes.sync(started);
    this.start(
      started,
      workspace.path,
      cli,
      env,
      await this.prepareRole(started, workspace.path, cli),
    );
  }

  /**
   * The same session (R6). A process still alive after a rate limit gets « continue » typed in
   * its prompt instead (data-model « AgentState »).
   */
  private async resumeNow(workspace: Workspace, agent: Agent) {
    if (this.running.has(agent.id)) {
      this.pty.write(agent.id, 'continue\r');
      await this.change(workspace.id, agent.id, (a) => ({
        ...a,
        state: 'working',
        lastError: null,
        scheduledResume: null,
      }));
      return;
    }
    await this.startAgain(workspace, agent, agent.sessionId);
  }

  /** The time of a scheduled resume: only if nothing took it over meanwhile (FR-036). */
  private async resumeDue(resume: ScheduledResume) {
    const found = this.workspaces
      .list()
      .flatMap((workspace) => workspace.agents.map((agent) => ({ workspace, agent })))
      .find(({ agent }) => agent.id === resume.agentId);
    if (!found) return;
    const { workspace, agent } = found;
    const scheduled = agent.scheduledResume;
    if (
      agent.state !== 'error' ||
      agent.lastError?.kind !== 'rate-limit' ||
      scheduled?.at !== resume.at ||
      scheduled.attempt !== resume.attempt
    ) {
      return;
    }
    try {
      await this.resumeNow(workspace, agent);
    } catch {
      // Its CLI is gone (uninstalled since): the manual actions remain.
      await this.change(workspace.id, agent.id, (a) => ({ ...a, scheduledResume: null }));
    }
  }

  private async renamed(id: string, branch: string) {
    const running = this.running.get(id);
    if (!running) return;
    await this.workspaces.update(running.workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === id ? { ...a, branch } : a)),
    }));
    this.onBranch({ agentId: id, branch });
  }

  private async launchNow({ workspaceId, agents: drafts, counters, launchedBy }: LaunchRequest) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    const clis = drafts.map((draft) => this.installedCli(draft.cliId));
    this.validateOrchestrator(workspace, drafts, clis);
    await this.validate(workspace, drafts);

    const positions = freePositions(workspace.agents, drafts.length);
    const colors = freeColors(workspace.agents, drafts.length);
    const usedPorts = new Set([
      ...this.workspaces.list().flatMap((ws) => ws.agents.map((agent) => agent.port)),
      ...drafts.flatMap((draft) => (draft.port === null ? [] : [draft.port])),
    ]);

    const env = await this.resolveEnv();
    // One wait per launch, not per agent: a silent remote costs at most `fetchTimeoutMs` in all.
    if (drafts.some((draft) => draft.baseBranch === null)) {
      await within(this.git.fetchOrigin(workspace.path, workspace.mainBranch), this.fetchTimeoutMs);
    }
    const launched: Agent[] = [];
    for (const [index, draft] of drafts.entries()) {
      const position = positions[index] ?? 0;
      const port =
        draft.port ??
        (await allocatePort(position, usedPorts, { inUse: (p) => this.isPortInUse(p) }));
      usedPorts.add(port);
      const baseBranch = draft.baseBranch ?? workspace.mainBranch;
      // Without a chosen base, the worktree starts from origin/<main>, fetched first (a failed
      // fetch keeps the last one known); a lagging local main is no base.
      let start = baseBranch;
      if (draft.baseBranch === null) {
        if (await this.git.remoteBranchExists(workspace.path, workspace.mainBranch)) {
          start = `origin/${workspace.mainBranch}`;
        }
      }
      const worktree = await this.git.addWorktree(workspace.path, {
        cli: draft.cliId,
        position,
        base: start,
        ...(draft.branch === null ? {} : { branch: draft.branch }),
      });
      const role = draftRole(draft);
      // FR-003: what the draft leaves to the default comes from the role's profile, same CLI.
      const profile = role === null ? undefined : this.profileOf(workspace, role);
      const fromProfile = profile?.cliId === draft.cliId ? profile : undefined;
      const agent: Agent = {
        id: randomUUID(),
        workspaceId,
        position,
        color: colors[index] ?? 'slate',
        cliId: draft.cliId,
        model: draft.model ?? fromProfile?.model ?? null,
        permissionLevel: draft.permissionLevel,
        baseBranch,
        branch: worktree.branch,
        worktreePath: worktree.path,
        port,
        startCommand: draft.startCommand,
        sessionId: null,
        initialPrompt: null,
        alwaysAllowRules: [],
        state: 'starting',
        lastError: null,
        scheduledResume: null,
        review: { seen: {}, comments: [] },
        role,
        effort: draft.effort ?? fromProfile?.effort ?? null,
        launchedBy: launchedBy ?? null,
      };
      const cli = clis[index];
      if (!cli) throw new Error('unreachable: one CLI per draft');
      // Saved before the process starts: its first hook must find the agent.
      await this.workspaces.update(workspaceId, (ws) => ({ ...ws, agents: [...ws.agents, agent] }));
      this.start(
        agent,
        workspace.path,
        cli,
        env,
        await this.prepareRole(agent, workspace.path, cli),
      );
      launched.push(agent);
    }
    await this.workspaces.update(workspaceId, (ws) => ({ ...ws, quickLaunchCounters: counters }));
    return launched;
  }

  /** The user's profile of a role, else its default one (004 R2). */
  private profileOf(workspace: Workspace, role: NonNullable<Agent['role']>) {
    return profilesOf(workspace.roleProfiles, this.registry.list())[role];
  }

  private installedCli(cliId: string): InstalledCli {
    const cli = this.registry.get(cliId);
    if (cli?.definition.status !== 'installed' || !cli.definition.resolvedPath) {
      throw new IpcFailure('INVALID_INPUT', `Le CLI « ${cliId} » n’est pas disponible.`);
    }
    return { adapter: cli.adapter, executablePath: cli.definition.resolvedPath };
  }

  /** The whole batch is checked before any worktree exists (FR-011 scenario 5). */
  private async validate(workspace: Workspace, drafts: AgentDraft[]) {
    // A closed agent keeps its worktree and its place (006): it is no live agent, it does not count.
    const live = workspace.agents.filter((agent) => agent.state !== 'closed').length;
    if (live + drafts.length > MAX_AGENTS) {
      throw new IpcFailure('LIMIT', `Six agents au plus par projet.`);
    }
    if (freePositions(workspace.agents, drafts.length).length < drafts.length) {
      throw new IpcFailure(
        'LIMIT',
        'Des agents fermés gardent leur place : relancez-les ou supprimez-les.',
      );
    }
    const branches = new Set(workspace.agents.map((agent) => agent.branch));
    for (const { branch } of drafts) {
      if (branch === null) continue;
      if (branches.has(branch) || (await this.git.branchExists(workspace.path, branch))) {
        throw new IpcFailure('BRANCH_CONFLICT', `La branche « ${branch} » existe déjà.`);
      }
      branches.add(branch);
    }
    const ports = new Set(this.workspaces.list().flatMap((ws) => ws.agents.map((a) => a.port)));
    for (const { port } of drafts) {
      if (port === null) continue;
      if (ports.has(port) || (await this.isPortInUse(port))) {
        throw new IpcFailure('PORT_CONFLICT', `Le port ${String(port)} est déjà utilisé.`);
      }
      ports.add(port);
    }
  }

  /** Starts the agent's CLI; a known `sessionId` resumes that session (R6). */
  /** 003 — at most one orchestrator per workspace, of a CLI that can be one (FR-001, R8). */
  private validateOrchestrator(workspace: Workspace, drafts: AgentDraft[], clis: InstalledCli[]) {
    const asked = drafts.filter((draft) => draftRole(draft) === 'orchestrator').length;
    if (asked === 0) return;
    if (!this.orchestrator) throw new IpcFailure('INVALID_INPUT', 'Orchestrateur indisponible.');
    if (asked + workspace.agents.filter((agent) => agent.role === 'orchestrator').length > 1) {
      throw new IpcFailure('INVALID_INPUT', 'Un seul orchestrateur par workspace.');
    }
    if (
      drafts.some(
        (draft, i) => draftRole(draft) === 'orchestrator' && !clis[i]?.adapter.supportsOrchestrator,
      )
    ) {
      throw new IpcFailure('INVALID_INPUT', 'Ce CLI ne peut pas être orchestrateur.');
    }
  }

  /**
   * 003 R2, 004 R3 — what an agent with a role starts with: the orchestrator's plugin and token, or
   * the MCP access of another role; its skills either way. A generic CLI reads them from
   * `.pact/ROLE.md`, told to before any other prompt.
   */
  private async prepareRole(agent: Agent, repoPath: string, cli: InstalledCli): Promise<Prepared> {
    const none = { orchestrator: null, agentMcp: null, skills: null };
    if (agent.role === null || !this.orchestrator) return none;
    let prepared: Prepared;
    if (agent.role === 'orchestrator') {
      const orchestrator = await this.orchestrator.prepare(agent);
      prepared = { orchestrator, agentMcp: null, skills: orchestrator.skills };
    } else {
      const agentMcp = (await this.orchestrator.prepareAgent?.(agent)) ?? null;
      if (!agentMcp) return none;
      prepared = { orchestrator: null, agentMcp, skills: agentMcp.skills };
    }
    if (cli.adapter.id === 'generic' && prepared.skills) {
      await writeRoleFile(agent.worktreePath, prepared.skills);
      await this.git.exclude?.(repoPath, `/${ROLE_FILE}`);
    }
    return prepared;
  }

  private start(
    agent: Agent,
    repoPath: string,
    cli: InstalledCli,
    env: ResolvedEnv,
    { orchestrator, agentMcp, skills }: Prepared = {
      orchestrator: null,
      agentMcp: null,
      skills: null,
    },
  ) {
    const { adapter } = cli;
    const statusLine = (payload: unknown) => {
      const usage = this.running.get(agent.id)?.usage;
      return usage && this.usage ? this.usage.statusLine(usage.source, payload) : 'PACT';
    };
    const token = this.hooks.register(
      agent.id,
      (payload) => {
        const signal = adapter.mapHookEvent(payload);
        if (!signal) return {};
        if (this.alwaysAllowed(agent.id, signal)) {
          if (adapter.permissionDecision) return adapter.permissionDecision('allow');
          this.pty.write(agent.id, adapter.answerKeys('allow'));
          return {};
        }
        void this.apply(agent.id, signal);
        return {};
      },
      ...(adapter.usageSource === 'claude-statusline' ? [statusLine] : []),
    );
    const input = {
      agentId: agent.id,
      executablePath: cli.executablePath,
      repoPath,
      cwd: agent.worktreePath,
      model: agent.model,
      effort: agent.effort,
      permissionLevel: agent.permissionLevel,
      port: agent.port,
      hook: { url: this.hookUrl(), token },
      orchestrator,
      agentMcp,
      skills,
    };
    const spec =
      agent.sessionId === null
        ? adapter.buildLaunch(input)
        : adapter.buildResume({ ...input, sessionId: agent.sessionId });
    const ownEnv = agentEnv(env, spec.env);
    const usage = this.usageOf(agent, adapter, ownEnv);
    this.running.set(agent.id, {
      workspaceId: agent.workspaceId,
      adapter,
      output: new TerminalText(),
      // No hook tells when a generic CLI is ready: its first output is its prompt.
      roleFilePrompt: adapter.id === 'generic' && skills !== null,
      ...(usage ? { usage } : {}),
    });
    this.pty.start(agent.id, {
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      env: ownEnv,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    this.branches.watch(agent.id, agent.worktreePath, agent.branch);
  }

  /** 005 R3 — the account of the agent's CLI: its configuration folder, or `default`. */
  private usageOf(agent: Agent, adapter: CliAdapter, env: Record<string, string>) {
    if (!this.usage || !adapter.usageSource) return undefined;
    const folder =
      adapter.usageSource === 'claude-statusline' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
    const name = this.registry.get(agent.cliId)?.definition.name ?? agent.cliId;
    const source: UsageSource = {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      label: `${name} ${String(agent.position)}`,
      role: agent.role,
      cliId: agent.cliId,
      account: accountOf(folder),
    };
    return { source, codexHome: env.CODEX_HOME || join(env.HOME || homedir(), '.codex') };
  }

  /** A request the user already allowed for this worktree (FR-034). */
  private alwaysAllowed(id: string, signal: AgentSignal) {
    if (signal.type !== 'awaiting-answer' || signal.ruleKey === undefined) return false;
    return this.find(id).agent.alwaysAllowRules.includes(signal.ruleKey);
  }

  private readOutput(id: string, data: string) {
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.idle);
    if (running.roleFilePrompt) {
      running.roleFilePrompt = false;
      this.pty.write(id, `${ROLE_FILE_PROMPT}\r`);
    }
    const signal = running.adapter.mapOutput(running.output.push(data), {});
    if (signal) {
      running.output.consume();
      void this.apply(id, signal);
      return;
    }
    // CLIs without hooks: a question is output that stays unanswered (contracts/cli-adapter.md).
    running.idle = setTimeout(() => {
      const idle = running.adapter.mapOutput(running.output.text(), { idleMs: this.idleMs });
      if (!idle) return;
      running.output.consume();
      void this.apply(id, idle);
    }, this.idleMs);
  }

  private async exited(id: string, code: number | null) {
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.idle);
    this.running.delete(id);
    this.hooks.unregister(id);
    this.usage?.release(id);
    this.branches.unwatch(id);
    this.promptTyped.delete(id);
    this.clearSubmission(id);
    this.pendingRule.delete(id);
    await this.change(running.workspaceId, id, (agent) => applyExit(agent, code));
  }

  private async apply(id: string, signal: AgentSignal) {
    const running = this.running.get(id);
    if (!running) return;
    // A request without a ruleKey (a Notification) keeps the one its PermissionRequest gave.
    if (signal.type === 'awaiting-answer') {
      if (signal.ruleKey !== undefined) this.pendingRule.set(id, signal.ruleKey);
      this.questions.set(id, signal.summary);
    } else {
      this.pendingRule.delete(id);
      this.questions.delete(id);
    }
    // 005 R2 — Codex names its rollout after the session: followed from its start.
    if (
      signal.type === 'session-started' &&
      signal.sessionId !== undefined &&
      running.adapter.usageSource === 'codex-rollout' &&
      running.usage
    ) {
      this.usage?.follow(running.usage.source, {
        codexHome: running.usage.codexHome,
        sessionId: signal.sessionId,
      });
    }
    const source = running.usage?.source;
    const resetAt =
      signal.type !== 'failed'
        ? undefined
        : (signal.resetAt ?? (source && this.usage?.resetAt?.(source.cliId, source.account)));
    const schedule =
      signal.type === 'failed' &&
      signal.kind === 'rate-limit' &&
      (await this.autoResumeOn(running.workspaceId));
    // Planned once, outside `change` (its callback may run twice), then saved with the error:
    // one agent:state event carries both.
    const before = this.find(id).agent;
    const resume =
      schedule && applySignal(before, signal).state === 'error'
        ? this.resumes.plan(before, resetAt)
        : null;
    await this.change(running.workspaceId, id, (agent) => {
      const next = applySignal(agent, signal);
      return resume && next.state === 'error' && !next.scheduledResume
        ? { ...next, scheduledResume: resume }
        : next;
    });
    if (signal.type === 'turn-finished') {
      if (this.find(id).agent.state === 'done') this.resumes.forget(id);
      await this.branches.check(id);
    }
  }

  /** Saves and announces a transition; `next` runs on the latest agent, inside the update. */
  private async change(workspaceId: string, id: string, next: (agent: Agent) => Agent) {
    const agent = this.workspaces.get(workspaceId)?.agents.find((a) => a.id === id);
    if (!agent || next(agent) === agent) return;
    let changed: Agent | undefined;
    await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === id ? (changed = next(a)) : a)),
    }));
    // Stopped during the save: the next manager takes over, this one arms and types nothing.
    if (!changed || this.disposed) return;
    this.emit(changed);
    this.resumes.sync(changed);
    if (isReady(changed.state)) this.flushPrompt(id);
    else {
      // Left the ready state: the prompt was taken, or something else took over.
      this.promptTyped.delete(id);
      this.clearSubmission(id);
    }
  }

  private flushPrompt(id: string) {
    const [next, ...rest] = this.prompts.get(id) ?? [];
    const state = this.find(id).agent.state;
    if (next === undefined || this.promptTyped.has(id) || !isReady(state) || !this.running.has(id))
      return;
    if (rest.length === 0) this.prompts.delete(id);
    else this.prompts.set(id, rest);
    this.promptTyped.add(id);
    const { text, origin } = next;
    // The Enter is its own write, after a pause: glued to a paste, it is swallowed.
    this.pty.write(id, text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text);
    this.onPromptTyped(id, origin);
    this.clearSubmission(id);
    this.submissions.set(id, {
      origin,
      timer: setTimeout(() => {
        this.submitEnter(id, origin, true);
      }, this.submitDelayMs),
    });
  }

  /**
   * Presses Enter; the agent should leave the ready state within `submitTimeoutMs`. If not, one
   * more Enter, then the prompt is given up as undelivered and the queue goes on. Its timers only
   * fire while the agent runs and stays ready: a stop, an exit or a change of state clears them.
   */
  private submitEnter(id: string, origin: PromptOrigin, retry: boolean) {
    this.pty.write(id, '\r');
    this.submissions.set(id, {
      origin,
      timer: setTimeout(() => {
        if (retry) {
          this.submitEnter(id, origin, false);
          return;
        }
        this.submissions.delete(id);
        const counts = this.undelivered.get(id) ?? { review: 0, orchestrator: 0, resume: 0 };
        this.undelivered.set(id, { ...counts, [origin]: counts[origin] + 1 });
        this.promptTyped.delete(id);
        this.flushPrompt(id);
      }, this.submitTimeoutMs),
    });
  }

  private clearSubmission(id: string) {
    const submission = this.submissions.get(id);
    if (!submission) return;
    clearTimeout(submission.timer);
    this.submissions.delete(id);
  }

  private emit({ id, state, lastError, scheduledResume, awaiting }: Agent, kept = false) {
    this.onState({
      agentId: id,
      state,
      lastError,
      scheduledResume,
      ...(awaiting ? { awaiting } : {}),
      ...(kept ? { kept } : {}),
    });
  }
}

function agentEnv(shell: ResolvedEnv, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    if (value !== undefined && !isParentClaudeVariable(name)) env[name] = value;
  }
  return { ...env, ...own };
}
