import { join } from 'node:path';
import type { Agent, AgentState, Workspace } from '../../shared/model';
import type { OrchestratorEvent } from '../../shared/orchestrator';
import type { OrchestratorLaunch } from '../agents/adapters/types';
import type { AgentStateEvent } from '../agents/agent-manager';
import type { HookServer } from '../agents/hook-server';
import { EventQueue, type WaitResult } from './events';
import { handleMcp, type McpTool } from './mcp';
import { writeOrchestratorPlugin } from './plugin';

// 003 — the orchestrator of each workspace: its session plugin, its token and the tools it
// reaches PACT with (research R2, R3).

type Options = {
  hooks: Pick<HookServer, 'registerMcp' | 'revokeMcp' | 'mcpUrl'>;
  workspaces: { list(): Workspace[] };
  /** `<userData>/orchestrator`: one session plugin per orchestrator. */
  pluginsDir: string;
  /** The tools an orchestrator gets, for its own id. */
  tools?: (orchestratorId: string) => readonly McpTool[];
};

type Session = { workspaceId: string; events: EventQueue };

export class OrchestratorService {
  private readonly sessions = new Map<string, Session>();
  /** The last state and workspace of each agent: a closed agent has left its workspace. */
  private readonly lastStates = new Map<string, { state: AgentState; workspaceId: string }>();

  constructor(private readonly options: Options) {}

  /** Writes the plugin and registers a new token: called on each start or resume (R2). */
  async prepare(agent: Pick<Agent, 'id' | 'workspaceId'>): Promise<OrchestratorLaunch> {
    const { hooks, pluginsDir, tools = () => [] } = this.options;
    const pluginDir = join(pluginsDir, agent.id, 'plugin');
    const url = hooks.mcpUrl();
    await writeOrchestratorPlugin(pluginDir, { url });
    const token = hooks.registerMcp(agent.id, (payload) => handleMcp(payload, tools(agent.id)));
    this.sessions.get(agent.id)?.events.close();
    this.sessions.set(agent.id, { workspaceId: agent.workspaceId, events: new EventQueue() });
    return { pluginDir, url, token };
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
    if (!event) return;
    for (const [orchestratorId, session] of this.sessions) {
      if (orchestratorId !== agentId && session.workspaceId === workspaceId) {
        session.events.push(event);
      }
    }
  }

  dispose(): void {
    for (const agentId of [...this.sessions.keys()]) this.release(agentId);
  }

  /** The role is gone or the agent is closed: its token stops working at once (FR-004, FR-007). */
  release(agentId: string): void {
    this.options.hooks.revokeMcp(agentId);
    this.sessions.get(agentId)?.events.close();
    this.sessions.delete(agentId);
  }

  isActive(agentId: string): boolean {
    return this.sessions.has(agentId);
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
