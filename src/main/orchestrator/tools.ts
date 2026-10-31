import type { Agent, Workspace } from '../../shared/model';
import type { AgentManager } from '../agents/agent-manager';
import type { McpTool, ToolResult } from './mcp';

// 003 contracts/mcp-tools.md — the tools of the pact MCP server, for one orchestrator. A refusal
// is a result marked as an error with its reason (FR-022), never a protocol error.

export type ToolDependencies = {
  workspaces: { list(): Workspace[] };
  agents: Pick<AgentManager, 'sendPrompt' | 'waitingPrompts' | 'questionOf'>;
  /** « Claude Code », « Codex »… */
  cliName: (cliId: string) => string;
  /** The agents of a workspace with changes to review (002 FR-002). */
  pending: (workspaceId: string) => Promise<string[]>;
};

const MAX_PROMPT = 8000;

/** Refused with its reason: the orchestrator reads it and adapts. */
class Refusal extends Error {}

/** A readable sentence, then the JSON of the contract. */
const reply = (text: string, json: unknown): ToolResult => ({
  content: [
    { type: 'text', text },
    { type: 'text', text: JSON.stringify(json) },
  ],
});

const refused = (reason: string): ToolResult => ({
  content: [{ type: 'text', text: reason }],
  isError: true,
});

const agentArgument = {
  type: 'string',
  description: 'L’agent visé : son nom affiché (« Codex 2 ») ou son identifiant.',
};

const stringArg = (args: unknown, key: string): string => {
  const value =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string') throw new Refusal(`Argument « ${key} » attendu.`);
  return value;
};

export function createOrchestratorTools(deps: ToolDependencies, orchestratorId: string): McpTool[] {
  const nameOf = (agent: Agent) => `${deps.cliName(agent.cliId)} ${String(agent.position)}`;

  /** The orchestrator's workspace, read at each call: agents come and go. */
  const workspace = () => {
    const found = deps.workspaces
      .list()
      .find((ws) => ws.agents.some((a) => a.id === orchestratorId));
    if (!found) throw new Refusal('L’orchestrateur n’est plus dans un workspace ouvert.');
    if (found.status !== 'available') throw new Refusal('Le dossier du workspace est introuvable.');
    return found;
  };

  /** By id or by displayed name, case ignored; never the orchestrator itself (FR-008). */
  const resolve = (reference: string): Agent => {
    const agents = workspace().agents;
    const wanted = reference.trim().toLowerCase();
    const found =
      agents.find((agent) => agent.id === reference) ??
      agents.find((agent) => nameOf(agent).toLowerCase() === wanted);
    if (!found) throw new Refusal(`Aucun agent « ${reference} » dans ce workspace.`);
    if (found.id === orchestratorId)
      throw new Refusal('L’orchestrateur ne se dirige pas lui-même.');
    return found;
  };

  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: unknown) => Promise<ToolResult>,
  ): McpTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    call: async (args) => {
      try {
        return await run(args);
      } catch (error) {
        if (error instanceof Refusal) return refused(error.message);
        throw error;
      }
    },
  });

  return [
    tool(
      'list_agents',
      'Liste les autres agents du workspace : nom, CLI, branche, état, question en attente de l’utilisateur, changements à relire, consignes de toi en attente.',
      {},
      [],
      async () => {
        const ws = workspace();
        const toReview = new Set(await deps.pending(ws.id));
        const agents = [...ws.agents]
          .filter((agent) => agent.id !== orchestratorId)
          .sort((a, b) => a.position - b.position)
          .map((agent) => ({
            id: agent.id,
            name: nameOf(agent),
            cli: deps.cliName(agent.cliId),
            branch: agent.branch,
            state: agent.state,
            question: agent.state === 'awaiting-answer' ? deps.agents.questionOf(agent.id) : null,
            toReview: toReview.has(agent.id),
            waitingPrompts: deps.agents.waitingPrompts(agent.id, 'orchestrator'),
          }));
        const lines = agents.map((a) => `${a.name} (${a.cli}, ${a.branch}) : ${a.state}`);
        return reply(lines.length > 0 ? lines.join('\n') : 'Aucun autre agent.', { agents });
      },
    ),
    tool(
      'send_prompt',
      'Envoie une consigne à un agent. Elle est tapée dans son invite dès qu’il est prêt, jamais pendant qu’il travaille ou attend une réponse de l’utilisateur. Donne une consigne précise et autonome.',
      { agent: agentArgument, text: { type: 'string', minLength: 1, maxLength: MAX_PROMPT } },
      ['agent', 'text'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        const text = stringArg(args, 'text');
        if (text.trim() === '' || text.length > MAX_PROMPT) {
          throw new Refusal(`Consigne de 1 à ${String(MAX_PROMPT)} caractères attendue.`);
        }
        if (agent.state === 'error') {
          throw new Refusal(`${nameOf(agent)} est en erreur : l’utilisateur doit le reprendre.`);
        }
        const position = await deps.agents.sendPrompt(agent.id, text, 'orchestrator');
        return reply(
          position === 0
            ? `Consigne tapée dans l’invite de ${nameOf(agent)}.`
            : `Consigne en file pour ${nameOf(agent)}, en position ${String(position)}.`,
          { queued: true, position },
        );
      },
    ),
  ];
}
