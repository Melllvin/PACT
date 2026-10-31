import { unifiedText } from '../../shared/diff';
import { repoPathSchema, type Agent, type Workspace } from '../../shared/model';
import type { OrchestratorEvent } from '../../shared/orchestrator';
import type { AgentManager } from '../agents/agent-manager';
import type { ReviewService } from '../review/review-service';
import type { TestRunner } from '../review/test-runner';
import type { WaitResult } from './events';
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
  review: Pick<ReviewService, 'readChanges' | 'readFileDiff' | 'testPlan'>;
  tests: Pick<TestRunner, 'run' | 'latest'>;
  /** The next events of these agents (all when undefined), or none after `timeoutMs` (R5). */
  wait: (agentIds: readonly string[] | undefined, timeoutMs: number) => Promise<WaitResult>;
};

const DEFAULT_WAIT_S = 300;
const MAX_WAIT_S = 600;

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

const argument = (args: unknown, key: string): unknown =>
  typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;

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
    tool(
      'get_changes',
      'Les changements d’un agent par rapport à la branche principale : fichiers, lignes ajoutées et retirées, état des tests, conflits. Lis-les avant toute demande d’intégration.',
      { agent: agentArgument },
      ['agent'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        const snapshot = await deps.review.readChanges(agent.id);
        if (snapshot.missing) throw new Refusal(`Le worktree de ${nameOf(agent)} est introuvable.`);
        const run = deps.tests.latest(agent.id);
        const tests = run && {
          status: run.status,
          command: run.command,
          passedCount: run.passedCount,
          outputTail: run.outputTail,
        };
        const { branch, files, added, removed, conflicts } = snapshot;
        const lines = files.map(
          (f) => `${f.status} ${f.path} +${String(f.added ?? 0)} −${String(f.removed ?? 0)}`,
        );
        return reply(
          [`${nameOf(agent)} (${branch}) : +${String(added)} −${String(removed)}`, ...lines].join(
            '\n',
          ),
          { branch, files, added, removed, tests, conflicts },
        );
      },
    ),
    tool(
      'get_file_diff',
      'Le diff d’un fichier changé par un agent, en texte unifié.',
      { agent: agentArgument, path: { type: 'string', description: 'Chemin relatif au dépôt.' } },
      ['agent', 'path'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        const path = stringArg(args, 'path');
        if (!repoPathSchema.safeParse(path).success) {
          throw new Refusal('Chemin relatif au dépôt attendu.');
        }
        const { file, diff } = await deps.review.readFileDiff(agent.id, path).catch(() => {
          throw new Refusal(`« ${path} » ne fait pas partie des changements de ${nameOf(agent)}.`);
        });
        if (file.binary || file.tooLarge) {
          const kind = file.binary ? 'binary' : 'tooLarge';
          return reply(`${path} : pas de diff ligne à ligne (${String(diff.size)} octets).`, {
            path,
            [kind]: true,
            size: diff.size,
          });
        }
        const unified = unifiedText(diff.hunks);
        return reply(unified, { path, unified });
      },
    ),
    tool(
      'run_tests',
      'Lance la commande de test du workspace dans le worktree d’un agent. Le résultat arrive dans get_changes.',
      { agent: agentArgument },
      ['agent'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        const { target, command, tree } = await deps.review.testPlan(agent.id);
        if (command === null) {
          throw new Refusal(
            'Tests non configurés : l’utilisateur doit saisir une commande de test.',
          );
        }
        await deps.tests.run(target, command, tree);
        return reply(`Tests lancés pour ${nameOf(agent)} : ${command}`, { status: 'running' });
      },
    ),
    tool(
      'wait_for_agents',
      'Attend la fin de tour, une question, une erreur, une fermeture ou l’issue d’une intégration chez les agents donnés (tous par défaut), au plus timeoutSeconds. Préfère-le à des appels répétés de list_agents.',
      {
        agents: { type: 'array', items: agentArgument },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_S },
      },
      [],
      async (args) => {
        const refs = argument(args, 'agents');
        const ids = Array.isArray(refs) ? refs.map((ref) => resolve(String(ref)).id) : undefined;
        const seconds = argument(args, 'timeoutSeconds') ?? DEFAULT_WAIT_S;
        if (
          typeof seconds !== 'number' ||
          !Number.isInteger(seconds) ||
          seconds < 1 ||
          seconds > MAX_WAIT_S
        ) {
          throw new Refusal(`Délai de 1 à ${String(MAX_WAIT_S)} secondes attendu.`);
        }
        const { events, timedOut, replaced } = await deps.wait(ids, seconds * 1000);
        const names = new Map(workspace().agents.map((a) => [a.id, nameOf(a)]));
        const text = replaced
          ? 'Attente remplacée par une autre.'
          : timedOut
            ? 'Aucun changement.'
            : events
                .map((event) => describe(event, names.get(event.agentId) ?? event.agentId))
                .join('\n');
        return reply(text, { events, timedOut });
      },
    ),
  ];
}

/** One line per event, for the orchestrator to read. */
function describe(event: OrchestratorEvent, name: string): string {
  switch (event.kind) {
    case 'turn-finished':
      return `${name} a fini son tour.`;
    case 'awaiting-answer':
      return `${name} attend une réponse de l’utilisateur.`;
    case 'error':
      return `${name} est en erreur : ${event.summary}`;
    case 'closed':
      return `${name} a été fermé.`;
    case 'integration':
      return `${name} : intégration ${event.integration?.outcome ?? ''}. ${event.summary}`;
  }
}
