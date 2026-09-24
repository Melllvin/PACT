import { randomUUID } from 'node:crypto';
import { IpcFailure, type AgentDraft, type IpcEvent } from '../../shared/ipc';
import { AGENT_COLORS, MAX_AGENTS, type Agent, type Workspace } from '../../shared/model';
import type { GitService } from '../git/git-service';
import { allocatePort, isPortInUse as defaultIsPortInUse } from '../ports/port-allocator';
import type { PtyManager } from '../pty/pty-manager';
import type { AgentSignal, CliAdapter, ResolvedEnv } from './adapters/types';
import { applyExit, applySignal } from './agent-state';
import type { RegisteredCli } from './cli-registry';
import type { HookServer } from './hook-server';
import { TerminalText } from './terminal-text';

// US2 — agents launched in their own worktree and pseudo-terminal, followed through their hooks
// (FR-009…FR-018, FR-038, FR-039).

export type AgentStateEvent = IpcEvent<'agent:state'>;

type WorkspaceAccess = {
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

type Options = {
  workspaces: WorkspaceAccess;
  registry: { get(id: string): RegisteredCli | undefined };
  git: Pick<GitService, 'addWorktree' | 'branchExists'>;
  pty: PtyManager;
  hooks: Pick<HookServer, 'register' | 'unregister'>;
  /** Base URL of the hook server, known once it listens. */
  hookUrl: () => string;
  resolveEnv: () => Promise<ResolvedEnv>;
  isPortInUse?: (port: number) => Promise<boolean>;
  onState?: (event: AgentStateEvent) => void;
};

export type LaunchRequest = {
  workspaceId: string;
  agents: AgentDraft[];
  counters: Workspace['quickLaunchCounters'];
};

type Running = { workspaceId: string; adapter: CliAdapter; output: TerminalText };

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
  private readonly running = new Map<string, Running>();
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
   * (FR-038). A rate limit keeps its reason and its scheduled resume.
   */
  async restore(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const stale = (agent: Agent) =>
      agent.state !== 'closed' && agent.state !== 'error' && !this.pty.has(agent.id);
    const changed = workspace.agents.filter(stale);
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

  /** Stops every agent process on quit; their last known state stays saved. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.unsubscribe) stop();
    const ids = [...this.running.keys()];
    for (const id of ids) this.hooks.unregister(id);
    this.running.clear();
    await Promise.all(ids.map((id) => this.pty.kill(id)));
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

  private installedCli(cliId: string) {
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

  private start(
    agent: Agent,
    repoPath: string,
    cli: { adapter: CliAdapter; executablePath: string },
    env: ResolvedEnv,
  ) {
    const { adapter } = cli;
    const token = this.hooks.register(agent.id, (payload) => {
      const signal = adapter.mapHookEvent(payload);
      if (signal) void this.apply(agent.id, signal);
      return {};
    });
    const spec = adapter.buildLaunch({
      agentId: agent.id,
      executablePath: cli.executablePath,
      repoPath,
      cwd: agent.worktreePath,
      model: agent.model,
      permissionLevel: agent.permissionLevel,
      port: agent.port,
      hook: { url: this.hookUrl(), token },
    });
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
  }

  private readOutput(id: string, data: string) {
    const running = this.running.get(id);
    if (!running) return;
    const signal = running.adapter.mapOutput(running.output.push(data), {});
    if (!signal) return;
    running.output.consume();
    void this.apply(id, signal);
  }

  private async exited(id: string, code: number) {
    const running = this.running.get(id);
    if (!running) return;
    this.running.delete(id);
    this.hooks.unregister(id);
    await this.change(running.workspaceId, id, (agent) => applyExit(agent, code));
  }

  private async apply(id: string, signal: AgentSignal) {
    const running = this.running.get(id);
    if (!running) return;
    await this.change(running.workspaceId, id, (agent) => applySignal(agent, signal));
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
    if (changed) this.emit(changed);
  }

  private emit({ id, state, lastError, scheduledResume }: Agent) {
    this.onState({ agentId: id, state, lastError, scheduledResume });
  }
}

/** Positions 1…6 not taken yet, lowest first. */
function freePositions(agents: Agent[], count: number) {
  const taken = new Set(agents.map((agent) => agent.position));
  const free = Array.from({ length: MAX_AGENTS }, (_, i) => i + 1).filter((p) => !taken.has(p));
  return free.slice(0, count);
}

/** Colors go in the order of AGENT_COLORS and an agent keeps its color (FR-016). */
function freeColors(agents: Agent[], count: number) {
  const taken = new Set(agents.map((agent) => agent.color));
  return AGENT_COLORS.filter((color) => !taken.has(color)).slice(0, count);
}

function agentEnv(shell: ResolvedEnv, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    if (value !== undefined && !isParentClaudeVariable(name)) env[name] = value;
  }
  return { ...env, ...own };
}
