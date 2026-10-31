import { join } from 'node:path';
import type { Agent } from '../../shared/model';
import type { OrchestratorLaunch } from '../agents/adapters/types';
import type { HookServer } from '../agents/hook-server';
import { handleMcp, type McpTool } from './mcp';
import { writeOrchestratorPlugin } from './plugin';

// 003 — the orchestrator of each workspace: its session plugin, its token and the tools it
// reaches PACT with (research R2, R3).

type Options = {
  hooks: Pick<HookServer, 'registerMcp' | 'revokeMcp' | 'mcpUrl'>;
  /** `<userData>/orchestrator`: one session plugin per orchestrator. */
  pluginsDir: string;
  /** The tools an orchestrator gets, for its own id. */
  tools?: (orchestratorId: string) => readonly McpTool[];
};

export class OrchestratorService {
  private readonly sessions = new Set<string>();

  constructor(private readonly options: Options) {}

  /** Writes the plugin and registers a new token: called on each start or resume (R2). */
  async prepare(agent: Pick<Agent, 'id'>): Promise<OrchestratorLaunch> {
    const { hooks, pluginsDir, tools = () => [] } = this.options;
    const pluginDir = join(pluginsDir, agent.id, 'plugin');
    const url = hooks.mcpUrl();
    await writeOrchestratorPlugin(pluginDir, { url });
    const token = hooks.registerMcp(agent.id, (payload) => handleMcp(payload, tools(agent.id)));
    this.sessions.add(agent.id);
    return { pluginDir, url, token };
  }

  /** The role is gone or the agent is closed: its token stops working at once (FR-004, FR-007). */
  release(agentId: string): void {
    this.options.hooks.revokeMcp(agentId);
    this.sessions.delete(agentId);
  }

  isActive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }
}
