import { join } from 'node:path';
import type { Agent, AgentState, Workspace } from '../../shared/model';
import type { Role } from '../../shared/primitives';
import { randomUUID } from 'node:crypto';
import type { OrchestratorAction, OrchestratorEvent } from '../../shared/orchestrator';
import type { AgentMcpLaunch, OrchestratorLaunch } from '../agents/adapters/types';
import type { AgentStateEvent } from '../agents/agent-manager';
import type { HookServer } from '../agents/hook-server';
import { createAgentTools } from './agent-tools';
import { EventQueue, type WaitResult } from './events';
import { handleMcp, type McpTool } from './mcp';
import { removeRoleFiles, writeRoleSkills } from './role-skills';

// 003 — the orchestrator of each workspace: its session plugin, its token and the tools it
// reaches PACT with (research R2, R3).

type Options = {
  hooks: Pick<HookServer, 'registerMcp' | 'revokeMcp' | 'mcpUrl'>;
  workspaces: { list(): Workspace[] };
  /** `<userData>/roles`: the copy of its skills and its session plugin, per agent (004 R3). */
  rolesDir: string;
  /** The suite of skills shipped with PACT (`resources/skills`). */
  skillsDir: string;
  /** The tools an orchestrator gets, for its own id. */
  tools?: (orchestratorId: string) => readonly McpTool[];
  /** 004 R5 — the tools of an agent with another role: submit_report by default. */
  agentTools?: (agentId: string) => readonly McpTool[];
  /** Each new entry of a journal (`orchestrator:action`, US5). */
  onAction?: (orchestratorId: string, action: OrchestratorAction) => void;
  /** 004 R5 — an agent's turn ended: its loop checks it gave a report. */
  onTurnFinished: (agentId: string) => void;
};

/** 004 US2 — what a loop tells the orchestrator: a report, a missing one, its end, an overlap. */
export type Notice = {
  agentId: string;
  kind: 'report' | 'report-missing' | 'loop' | 'overlap' | 'publish' | 'mockup';
  summary: string;
};

/** The journal keeps the latest actions only (FR-021). */
const MAX_ACTIONS = 200;

type Session = { workspaceId: string; events: EventQueue };

export class OrchestratorService {
  private readonly sessions = new Map<string, Session>();
  /** The last state and workspace of each agent: a closed agent has left its workspace. */
  private readonly lastStates = new Map<string, { state: AgentState; workspaceId: string }>();
  /** By orchestrator, the latest first. */
  private readonly journals = new Map<string, OrchestratorAction[]>();

  constructor(private readonly options: Options) {}

  /** Writes the skills and plugin, registers a new token: on each start or resume (R2, 004 R3). */
  async prepare(agent: Pick<Agent, 'id' | 'workspaceId'>): Promise<OrchestratorLaunch> {
    const { hooks, tools = () => [] } = this.options;
    const url = hooks.mcpUrl();
    const skills = await this.writeSkills(agent.id, 'orchestrator', url);
    const token = hooks.registerMcp(agent.id, (payload) => handleMcp(payload, tools(agent.id)));
    this.sessions.get(agent.id)?.events.close();
    this.sessions.set(agent.id, { workspaceId: agent.workspaceId, events: new EventQueue() });
    return { pluginDir: skills.pluginDir, url, token, skills };
  }

  /**
   * 004 R5 — a token of its own for an agent with a role: it opens submit_report only; with the
   * skills of its role (R3).
   */
  async prepareAgent(agent: Pick<Agent, 'id' | 'role'>): Promise<AgentMcpLaunch> {
    const { hooks, agentTools = (id: string) => createAgentTools({}, id) } = this.options;
    const url = hooks.mcpUrl();
    const skills = await this.writeSkills(agent.id, agent.role ?? 'dev', url);
    const token = hooks.registerMcp(agent.id, (payload) =>
      handleMcp(payload, agentTools(agent.id), { refusal: 'Outil réservé à l’orchestrateur.' }),
    );
    return { url, token, skills };
  }

  private writeSkills(agentId: string, role: Role, url: string) {
    const { rolesDir, skillsDir } = this.options;
    return writeRoleSkills(join(rolesDir, agentId), { role, skillsDir, url });
  }

  /** What the orchestrator waits for (R5); refused once its session is gone. */
  wait(
    orchestratorId: string,
    agentIds: readonly string[] | undefined,
    timeoutMs: number,
  ): Promise<WaitResult> {
    const session = this.sessions.get(orchestratorId);
    if (!session) return Promise.resolve({ events: [], timedOut: false, replaced: true });
    return session.events.wait(agentIds, timeoutMs);
  }

  /** An agent changed state: the orchestrator of its workspace hears of what matters (R5). */
  agentState({ agentId, state, lastError }: AgentStateEvent): void {
    const workspaceId =
      this.options.workspaces.list().find((ws) => ws.agents.some((a) => a.id === agentId))?.id ??
      this.lastStates.get(agentId)?.workspaceId;
    if (workspaceId === undefined) return;
    const previous = this.lastStates.get(agentId)?.state;
    this.lastStates.set(agentId, { state, workspaceId });
    const event = eventOf(agentId, state, previous, lastError?.message ?? '');
    if (event) this.push(workspaceId, event);
    if (event?.kind === 'turn-finished') this.options.onTurnFinished(agentId);
  }

  /** A loop's notice, with the agent's state as it is now. */
  notice(workspaceId: string, { agentId, kind, summary }: Notice): void {
    const agent = this.options.workspaces
      .list()
      .flatMap((ws) => ws.agents)
      .find((a) => a.id === agentId);
    const state = agent?.state ?? this.lastStates.get(agentId)?.state ?? 'closed';
    this.push(workspaceId, { at: new Date().toISOString(), agentId, kind, state, summary });
  }

  /**
   * Tells the orchestrators of a workspace, never about themselves, save the user's answer to
   * their own request to publish issues (004 FR-023).
   */
  push(workspaceId: string, event: OrchestratorEvent): void {
    for (const [orchestratorId, session] of this.sessions) {
      const about = orchestratorId === event.agentId && event.kind !== 'publish';
      if (!about && session.workspaceId === workspaceId) {
        session.events.push(event);
      }
    }
  }

  /** An action of the orchestrator, done or refused (FR-021). */
  record(orchestratorId: string, entry: Omit<OrchestratorAction, 'id' | 'at'>): void {
    const action: OrchestratorAction = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    const journal = [action, ...(this.journals.get(orchestratorId) ?? [])].slice(0, MAX_ACTIONS);
    this.journals.set(orchestratorId, journal);
    this.options.onAction?.(orchestratorId, action);
  }

  actions(orchestratorId: string): OrchestratorAction[] {
    return this.journals.get(orchestratorId) ?? [];
  }

  dispose(): void {
    for (const agentId of [...this.sessions.keys()]) this.release(agentId);
  }

  /** The role is gone or the agent is closed: its token stops working at once (FR-004, FR-007). */
  release(agentId: string): void {
    // Its copy of the skills goes too, and the `.pact/ROLE.md` of a generic CLI (004 R3).
    const worktree =
      this.options.workspaces
        .list()
        .flatMap((ws) => ws.agents)
        .find((a) => a.id === agentId)?.worktreePath ?? null;
    void removeRoleFiles(join(this.options.rolesDir, agentId), worktree);
    this.options.hooks.revokeMcp(agentId);
    this.sessions.get(agentId)?.events.close();
    this.sessions.delete(agentId);
  }
}

/** The changes of state an orchestrator waits for; the others say nothing (R5). */
function eventOf(
  agentId: string,
  state: AgentState,
  previous: AgentState | undefined,
  error: string,
): OrchestratorEvent | null {
  const at = new Date().toISOString();
  const base = { at, agentId, state };
  if (state === 'done' || (state === 'awaiting-prompt' && previous === 'working')) {
    return { ...base, kind: 'turn-finished', summary: '' };
  }
  if (state === 'awaiting-answer') {
    return { ...base, kind: 'awaiting-answer', summary: 'Une question attend l’utilisateur' };
  }
  if (state === 'error') return { ...base, kind: 'error', summary: error };
  if (state === 'closed') return { ...base, kind: 'closed', summary: '' };
  return null;
}
