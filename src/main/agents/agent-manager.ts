import { randomUUID } from 'node:crypto';
import { IpcFailure, type AgentDraft, type IpcEvent } from '../../shared/ipc';
import { freeColors, freePositions } from '../../shared/launch-draft';
import { MAX_AGENTS, type Agent, type ScheduledResume, type Workspace } from '../../shared/model';
import type { GitService } from '../git/git-service';
import { allocatePort, isPortInUse as defaultIsPortInUse } from '../ports/port-allocator';
import type { PtyManager } from '../pty/pty-manager';
import { IDLE_QUESTION_MS } from './adapters/generic';
import type { AgentSignal, CliAdapter, ResolvedEnv } from './adapters/types';
import { applyExit, applySignal } from './agent-state';
import { AutoResume, type Clock } from './auto-resume';
import { BranchWatcher } from './branch-watcher';
import type { RegisteredCli } from './cli-registry';
import type { HookServer } from './hook-server';
import { TerminalText } from './terminal-text';

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
  registry: { get(id: string): RegisteredCli | undefined };
  git: Pick<GitService, 'addWorktree' | 'branchExists' | 'currentBranch' | 'removeWorktree'>;
  pty: PtyManager;
  hooks: Pick<HookServer, 'register' | 'unregister'>;
  /** Base URL of the hook server, known once it listens. */
  hookUrl: () => string;
  resolveEnv: () => Promise<ResolvedEnv>;
  isPortInUse?: (port: number) => Promise<boolean>;
  onState?: (event: AgentStateEvent) => void;
  onBranch?: (event: AgentBranchEvent) => void;
  /** Quiet time after which the output is read again for a question (generic adapter). */
  idleMs?: number;
  /** Whether a rate limit in this workspace is resumed without asking (FR-035); off by default. */
  autoResume?: (workspaceId: string) => Promise<boolean>;
  clock?: Clock;
};

export type LaunchRequest = {
  workspaceId: string;
  agents: AgentDraft[];
  counters: Workspace['quickLaunchCounters'];
};

type Running = {
  workspaceId: string;
  adapter: CliAdapter;
  output: TerminalText;
  idle?: ReturnType<typeof setTimeout>;
};
type InstalledCli = { adapter: CliAdapter; executablePath: string };

/** Set by the Claude Code session PACT may be started from; an agent must not inherit them. */
const isParentClaudeVariable = (name: string) =>
  name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_');

const RESTORED_MESSAGE = 'PACT a redémarré : agent à reprendre.';

export class AgentManager {
  private readonly workspaces: WorkspaceAccess;
  private readonly registry: Options['registry'];
  private readonly git: Options['git'];
  private readonly pty: PtyManager;
  private readonly hooks: Options['hooks'];
  private readonly hookUrl: () => string;
  private readonly resolveEnv: () => Promise<ResolvedEnv>;
  private readonly isPortInUse: (port: number) => Promise<boolean>;
  private readonly onState: NonNullable<Options['onState']>;
  private readonly onBranch: NonNullable<Options['onBranch']>;
  private readonly branches: BranchWatcher;
  private readonly idleMs: number;
  private readonly autoResumeOn: (workspaceId: string) => Promise<boolean>;
  private readonly resumes: AutoResume;
  private readonly running = new Map<string, Running>();
  /** The ruleKey of the request each agent waits on, for « Toujours pour ce worktree ». */
  private readonly pendingRule = new Map<string, string>();
  /** Initial prompts « Relancer » types again once the new session shows its prompt. */
  private readonly retype = new Map<string, string>();
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
    this.isPortInUse = options.isPortInUse ?? defaultIsPortInUse;
    this.onState = options.onState ?? (() => undefined);
    this.onBranch = options.onBranch ?? (() => undefined);
    this.idleMs = options.idleMs ?? IDLE_QUESTION_MS;
    this.autoResumeOn = options.autoResume ?? (() => Promise.resolve(false));
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
    return run;
  }

  /**
   * After a restart no agent process exists any more: live agents become « à reprendre »
   * (FR-038). A rate limit keeps its reason and its scheduled resume, armed again.
   */
  async restore(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    await this.markStale(workspace);
    for (const agent of this.workspaces.get(workspaceId)?.agents ?? []) {
      if (agent.state === 'error') this.resumes.sync(agent);
    }
  }

  private async markStale({ id: workspaceId, agents }: Workspace) {
    const stale = (agent: Agent) =>
      agent.state !== 'closed' && agent.state !== 'error' && !this.pty.has(agent.id);
    const changed = agents.filter(stale);
    if (changed.length === 0) return;
    const updated = await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((agent) =>
        stale(agent)
          ? {
              ...agent,
              state: 'error' as const,
              lastError: { code: null, kind: 'crash' as const, message: RESTORED_MESSAGE },
            }
          : agent,
      ),
    }));
    for (const agent of updated.agents) {
      if (changed.some((c) => c.id === agent.id)) this.emit(agent);
    }
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
    const rule = always && answer === 'allow' ? this.pendingRule.get(id) : undefined;
    this.pendingRule.delete(id);
    this.pty.write(id, running.adapter.answerKeys(answer));
    await this.change(workspace.id, id, (a) => ({
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
    if (!data.includes('\r')) return;
    const found = this.workspaces
      .list()
      .flatMap((workspace) => workspace.agents)
      .find((agent) => agent.id === id);
    if (found?.scheduledResume) void this.cancelAutoResume(id);
  }

  /** « Relancer »: a new session, then the initial prompt typed again (FR-024, R6). */
  async restart(id: string): Promise<void> {
    const { workspace, agent } = this.inError(id);
    this.resumes.forget(id);
    await this.stop(id);
    if (agent.initialPrompt !== null) this.retype.set(id, agent.initialPrompt);
    await this.startAgain(workspace, agent, null);
  }

  /** « Journal »: the output kept for the agent, across its restarts. */
  log(id: string): string {
    this.find(id);
    return this.pty.history(id);
  }

  /** Stops the agent and forgets it; its worktree and branch go only when asked (FR-037). */
  async close(id: string, { removeWorktree }: { removeWorktree: boolean }): Promise<void> {
    const { workspace, agent } = this.find(id);
    this.resumes.forget(id);
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
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.filter((a) => a.id !== id),
    }));
    this.emit({ ...agent, state: 'closed' });
  }

  /** Stops every agent process on quit; their last known state stays saved. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.unsubscribe) stop();
    this.branches.dispose();
    this.resumes.dispose();
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
    this.retype.delete(id);
    this.pendingRule.delete(id);
    this.branches.unwatch(id);
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.idle);
    this.running.delete(id);
    this.hooks.unregister(id);
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
    } as const;
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === agent.id ? { ...a, ...fields } : a)),
    }));
    const started: Agent = { ...agent, ...fields };
    this.emit(started);
    this.resumes.sync(started);
    this.start(started, workspace.path, cli, env);
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

  private async launchNow({ workspaceId, agents: drafts, counters }: LaunchRequest) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    const clis = drafts.map((draft) => this.installedCli(draft.cliId));
    await this.validate(workspace, drafts);

    const positions = freePositions(workspace.agents, drafts.length);
    const colors = freeColors(workspace.agents, drafts.length);
    const usedPorts = new Set([
      ...this.workspaces.list().flatMap((ws) => ws.agents.map((agent) => agent.port)),
      ...drafts.flatMap((draft) => (draft.port === null ? [] : [draft.port])),
    ]);

    const env = await this.resolveEnv();
    const launched: Agent[] = [];
    for (const [index, draft] of drafts.entries()) {
      const position = positions[index] ?? 0;
      const port =
        draft.port ??
        (await allocatePort(position, usedPorts, { inUse: (p) => this.isPortInUse(p) }));
      usedPorts.add(port);
      const baseBranch = draft.baseBranch ?? workspace.mainBranch;
      const worktree = await this.git.addWorktree(workspace.path, {
        cli: draft.cliId,
        position,
        base: baseBranch,
        ...(draft.branch === null ? {} : { branch: draft.branch }),
      });
      const agent: Agent = {
        id: randomUUID(),
        workspaceId,
        position,
        color: colors[index] ?? 'slate',
        cliId: draft.cliId,
        model: draft.model,
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
      };
      const cli = clis[index];
      if (!cli) throw new Error('unreachable: one CLI per draft');
      // Saved before the process starts: its first hook must find the agent.
      await this.workspaces.update(workspaceId, (ws) => ({ ...ws, agents: [...ws.agents, agent] }));
      this.start(agent, workspace.path, cli, env);
      launched.push(agent);
    }
    await this.workspaces.update(workspaceId, (ws) => ({ ...ws, quickLaunchCounters: counters }));
    return launched;
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
    if (workspace.agents.length + drafts.length > MAX_AGENTS) {
      throw new IpcFailure('LIMIT', `Six agents au plus par projet.`);
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
  private start(agent: Agent, repoPath: string, cli: InstalledCli, env: ResolvedEnv) {
    const { adapter } = cli;
    const token = this.hooks.register(agent.id, (payload) => {
      const signal = adapter.mapHookEvent(payload);
      if (!signal) return {};
      if (this.alwaysAllowed(agent.id, signal)) {
        if (adapter.permissionDecision) return adapter.permissionDecision('allow');
        this.pty.write(agent.id, adapter.answerKeys('allow'));
        return {};
      }
      void this.apply(agent.id, signal);
      return {};
    });
    const input = {
      agentId: agent.id,
      executablePath: cli.executablePath,
      repoPath,
      cwd: agent.worktreePath,
      model: agent.model,
      permissionLevel: agent.permissionLevel,
      port: agent.port,
      hook: { url: this.hookUrl(), token },
    };
    const spec =
      agent.sessionId === null
        ? adapter.buildLaunch(input)
        : adapter.buildResume({ ...input, sessionId: agent.sessionId });
    this.running.set(agent.id, {
      workspaceId: agent.workspaceId,
      adapter,
      output: new TerminalText(),
    });
    this.pty.start(agent.id, {
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      env: agentEnv(env, spec.env),
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    this.branches.watch(agent.id, agent.worktreePath, agent.branch);
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

  private async exited(id: string, code: number) {
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.idle);
    this.running.delete(id);
    this.hooks.unregister(id);
    this.branches.unwatch(id);
    this.retype.delete(id);
    this.pendingRule.delete(id);
    await this.change(running.workspaceId, id, (agent) => applyExit(agent, code));
  }

  private async apply(id: string, signal: AgentSignal) {
    const running = this.running.get(id);
    if (!running) return;
    // A request without a ruleKey (a Notification) keeps the one its PermissionRequest gave.
    if (signal.type === 'awaiting-answer') {
      if (signal.ruleKey !== undefined) this.pendingRule.set(id, signal.ruleKey);
    } else {
      this.pendingRule.delete(id);
    }
    const resetAt = signal.type === 'failed' ? signal.resetAt : undefined;
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
    if (!changed) return;
    this.emit(changed);
    this.resumes.sync(changed);
    const prompt = this.retype.get(id);
    if (changed.state === 'awaiting-prompt' && prompt !== undefined && this.running.has(id)) {
      this.retype.delete(id);
      this.pty.write(id, `${prompt}\r`);
    }
  }

  private emit({ id, state, lastError, scheduledResume }: Agent) {
    this.onState({ agentId: id, state, lastError, scheduledResume });
  }
}

function agentEnv(shell: ResolvedEnv, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    if (value !== undefined && !isParentClaudeVariable(name)) env[name] = value;
  }
  return { ...env, ...own };
}
