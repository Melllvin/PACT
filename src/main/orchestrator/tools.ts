import { unifiedText } from '../../shared/diff';
import { IpcFailure } from '../../shared/ipc';
import {
  EFFORTS,
  repoPathSchema,
  ROLES,
  effortSchema,
  roleSchema,
  type Agent,
  type CliDefinition,
  type Workspace,
} from '../../shared/model';
import { beyondCeiling, profilesOf } from '../../shared/roles';
import { ORCHESTRATOR_ACTION_TOOLS, type OrchestratorAction } from '../../shared/orchestrator';
import type { AgentManager } from '../agents/agent-manager';
import type { PermissionService } from '../agents/permission-service';
import type { ReviewService } from '../review/review-service';
import type { TestRunner } from '../review/test-runner';
import type { EventSummary, ExchangeService, WaitResult } from './exchange-service';
import type { IntegrationRequests } from './integration-requests';
import type { IssueService } from './issues';
import type { LoopService } from './loop-service';
import type { McpTool, ToolResult } from './mcp';
import {
  createEventsTool,
  createExchangeTools,
  type ExchangeReads,
  type ExchangeWrites,
} from './agent-tools';

// 003 contracts/mcp-tools.md — the tools of the pact MCP server, for one orchestrator. A refusal
// is a result marked as an error with its reason (FR-022), never a protocol error.

export type ToolDependencies = {
  workspaces: { list(): Workspace[] };
  agents: Pick<
    AgentManager,
    | 'sendPrompt'
    | 'waitingPrompts'
    | 'undeliveredPrompts'
    | 'questionOf'
    | 'launch'
    | 'close'
    | 'launchWarnings'
    | 'rememberInitialPrompt'
  >;
  /** The CLIs PACT knows, installed or not (US4). */
  clis: () => CliDefinition[];
  /** The level the launcher would use in this workspace (FR-015). */
  permissions: Pick<PermissionService, 'resolve'>;
  /** « Claude Code », « Codex »… */
  cliName: (cliId: string) => string;
  /** The agents of a workspace with changes to review (002 FR-002). */
  pending: (workspaceId: string) => Promise<string[]>;
  review: Pick<ReviewService, 'readChanges' | 'readFileDiff' | 'testPlan'>;
  tests: Pick<TestRunner, 'run' | 'latest'>;
  /** The next events of these agents (all when undefined), or none after `timeoutMs` (R5). */
  wait: (agentIds: readonly string[] | undefined, timeoutMs: number) => Promise<WaitResult>;
  /** 007 — the shared reading of the journal, for `get_events`. */
  exchanges?: ExchangeReads & Pick<ExchangeService, 'record'> & Partial<ExchangeWrites>;
  /** The integrations waiting for the user (US3). */
  requests: Pick<IntegrationRequests, 'request'>;
  /** 004 US2 — the dev ↔ test loops. */
  loops: Pick<LoopService, 'start' | 'next' | 'get'>;
  /** 004 US3 — the issues of the workspace, published once the user confirms. */
  issues: Pick<IssueService, 'register' | 'list' | 'requestPublish'>;
  /** 005 FR-012 — « Limite 5 h à 85 % : … » when a CLI is near its limit; never a refusal. */
  usageWarning?: (cliId: string) => string | null;
  /** The journal « ◎ Actions »: each action, done or refused (US5, FR-021). */
  log?: (entry: ActionEntry) => void;
};

export type ActionEntry = Omit<OrchestratorAction, 'id' | 'at'>;

const ACTIONS: readonly string[] = ORCHESTRATOR_ACTION_TOOLS;
const MAX_SUMMARY = 200;

// 007 FR-019 — a wait answers within a minute, with `timedOut`, and the orchestrator waits again:
// far below the 300 s after which Claude Code's HTTP MCP requests fail.
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 60;

const MAX_PROMPT = 8000;
const MAX_MESSAGE = 4000;
const MODES = ['squash', 'keep-commits'] as const;

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

/** An optional string argument: absent, or a string. */
const optionalString = (args: unknown, key: string): string | null => {
  const value = argument(args, key);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Refusal(`Argument « ${key} » : texte attendu.`);
  }
  return value.trim();
};

/** The loop's refusals become the orchestrator's (004 FR-018). */
const loopRefusal = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    // LoopService refuses with an Error and its reason.
    throw new Refusal((error as Error).message);
  }
};

/** The launcher's refusals (limit, branch, CLI) become the orchestrator's (FR-022). */
const asRefusal = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof IpcFailure) throw new Refusal(error.message);
    throw error;
  }
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
      let result: ToolResult;
      try {
        result = await run(args);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        result = refused(error.message);
      }
      if (ACTIONS.includes(name)) deps.log?.(entryOf(name, args, result));
      return result;
    },
  });

  /** The agent an action was about: the one launched, or the one named, when it exists. */
  const subjectOf = (name: string, args: unknown, result: ToolResult): string | null => {
    if (name === 'launch_agent' && result.isError !== true) {
      const json = result.content[1]?.text;
      const launched =
        json === undefined ? undefined : (JSON.parse(json) as Partial<{ agent: { id: string } }>);
      return launched?.agent?.id ?? null;
    }
    const reference = argument(args, 'agent');
    if (typeof reference !== 'string') return null;
    try {
      return resolve(reference).id;
    } catch {
      return null;
    }
  };

  /**
   * 007 R11, FR-015, FR-024 — a consigne is an `instruction` of the journal: the agent is woken by a
   * pointer and reads the text itself, whole. Nothing of it is typed. Gives the number of events
   * already waiting for the agent.
   */
  const instruct = async (agent: Agent, text: string): Promise<number> => {
    const journal = deps.exchanges;
    if (!journal) return deps.agents.sendPrompt(agent.id, text, 'orchestrator');
    const workspaceId = journal.workspaceOf(agent.id);
    if (workspaceId === undefined) throw new Refusal(`${nameOf(agent)} n’est plus ouvert.`);
    const waiting = deps.workspaces
      .list()
      .flatMap((ws) => (ws.id === workspaceId ? ws.exchanges.messages : []))
      .filter((m) => m.type === 'action' && m.unreadBy.includes(agent.id)).length;
    await journal.record(workspaceId, {
      from: orchestratorId,
      to: agent.id,
      kind: 'instruction',
      text,
      unreadBy: [agent.id],
    });
    await deps.agents.rememberInitialPrompt(agent.id, text);
    return waiting;
  };

  const entryOf = (name: string, args: unknown, result: ToolResult): ActionEntry => {
    const text = result.content[0]?.text ?? '';
    const refusedHere = result.isError === true;
    return {
      tool: name as ActionEntry['tool'],
      agentId: subjectOf(name, args, result),
      summary: text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text,
      outcome: refusedHere ? 'refused' : 'ok',
      reason: refusedHere ? text : null,
    };
  };

  /** The CLI of a launch: the one named, else the role's; and the role's profile on that CLI. */
  const launchCli = (ws: Workspace, role: Agent['role'], named: string | null) => {
    const clis = deps.clis();
    const profile = role === null ? undefined : profilesOf(ws.roleProfiles, clis)[role];
    if (named !== null) {
      const wanted = named.trim().toLowerCase();
      const cli = clis.find(
        (c) => c.id.toLowerCase() === wanted || c.name.toLowerCase() === wanted,
      );
      if (cli?.status !== 'installed') throw new Refusal(`Le CLI « ${named} » n’est pas installé.`);
      return { cli, profile: profile?.cliId === cli.id ? profile : undefined };
    }
    if (role === null) throw new Refusal('Donne le CLI ou le rôle de l’agent.');
    if (!profile) throw new Refusal(`Aucun CLI installé pour le rôle ${role}.`);
    const cli = clis.find((c) => c.id === profile.cliId);
    if (cli?.status !== 'installed') {
      throw new Refusal(
        `Le CLI « ${cli?.name ?? profile.cliId} » du rôle ${role} n’est pas installé.`,
      );
    }
    return { cli, profile };
  };

  return [
    ...(deps.exchanges
      ? [
          createEventsTool(deps.exchanges, orchestratorId),
          ...createExchangeTools(deps.exchanges, orchestratorId, { ask: false }),
        ]
      : []),
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
            role: agent.role,
            // 004 FR-006: the loop it works in, dev or test.
            loop: loopOf(ws, agent.id),
            state: agent.state,
            question: agent.state === 'awaiting-answer' ? deps.agents.questionOf(agent.id) : null,
            // 007 R8 — the whole questions of a blocked report, the journal keeping 2000 characters.
            questions: agent.lastReport?.questions ?? [],
            toReview: toReview.has(agent.id),
            waitingPrompts: deps.agents.waitingPrompts(agent.id, 'wake'),
            // Typed but never submitted, even after a second Enter.
            undeliveredPrompts: deps.agents.undeliveredPrompts(agent.id, 'wake'),
          }));
        const lines = agents.map(
          (a) => `${a.name}${a.role ? ` [${a.role}]` : ''} (${a.cli}, ${a.branch}) : ${a.state}`,
        );
        return reply(lines.length > 0 ? lines.join('\n') : 'Aucun autre agent.', { agents });
      },
    ),
    tool(
      'send_prompt',
      'Envoie une consigne à un agent. Elle est inscrite au journal ; PACT réveille l’agent par une ligne d’invite (« N événements, lis get_events ») quand il est prêt, jamais pendant qu’il travaille, et il lit la consigne entière par get_events. Rien ne garantit qu’il ait pris le pointeur : list_agents indique (undeliveredPrompts) ceux qui n’ont pas été soumis. Donne une consigne précise et autonome.',
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
        const position = await instruct(agent, text);
        return reply(
          position === 0
            ? `Consigne enregistrée pour ${nameOf(agent)} ; il la lira à son réveil (get_events). list_agents dira si le pointeur n’a pas été soumis.`
            : `Consigne enregistrée pour ${nameOf(agent)} derrière ${String(position)} événement(s) non lu(s).`,
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
      'launch_agent',
      'Lance un agent dans un nouveau worktree, avec le niveau d’autorisation choisi dans PACT. Avec un rôle, son profil donne le CLI, le modèle et l’effort ; un modèle au-delà du plafond du rôle est refusé. Donne-lui une consigne initiale précise et autonome. Six agents au plus par workspace, toi compris.',
      {
        role: { type: 'string', enum: [...ROLES], description: 'Le rôle de l’agent.' },
        cli: {
          type: 'string',
          description:
            'Le CLI : son nom (« Codex ») ou son identifiant ; par défaut, celui du rôle.',
        },
        model: {
          type: 'string',
          description: 'Le modèle ; par défaut, celui du rôle, sinon celui du CLI.',
        },
        effort: { type: 'string', enum: [...EFFORTS], description: 'L’effort de raisonnement.' },
        branch: {
          type: 'string',
          description: 'La branche à créer ; par défaut, une branche neuve.',
        },
        baseBranch: {
          type: 'string',
          description: 'La branche de départ ; par défaut, la principale.',
        },
        prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT },
      },
      [],
      async (args) => {
        const ws = workspace();
        const role = roleSchema.nullable().catch(null).parse(optionalString(args, 'role'));
        const { cli, profile } = launchCli(ws, role, optionalString(args, 'cli'));
        const model = optionalString(args, 'model') ?? profile?.model ?? null;
        if (role !== null && profile && beyondCeiling(model, profile.maxModel, cli.modelTiers)) {
          throw new Refusal(
            `Modèle au-delà du plafond du rôle ${role} (${profile.maxModel ?? ''})`,
          );
        }
        const effort =
          effortSchema.nullable().catch(null).parse(optionalString(args, 'effort')) ??
          profile?.effort ??
          null;
        const prompt = optionalString(args, 'prompt');
        if (prompt !== null && prompt.length > MAX_PROMPT) {
          throw new Refusal(`Consigne de 1 à ${String(MAX_PROMPT)} caractères attendue.`);
        }
        const preference = await deps.permissions.resolve(ws.id);
        if (!preference) {
          throw new Refusal(
            'Choisissez d’abord les autorisations dans PACT : l’utilisateur doit lancer un agent depuis PACT une première fois.',
          );
        }
        const [agent] = await asRefusal(() =>
          deps.agents.launch({
            workspaceId: ws.id,
            agents: [
              {
                cliId: cli.id,
                model,
                effort,
                role,
                permissionLevel: preference.level,
                baseBranch: optionalString(args, 'baseBranch'),
                branch: optionalString(args, 'branch'),
                port: null,
                startCommand: null,
              },
            ],
            counters: ws.quickLaunchCounters,
            launchedBy: orchestratorId,
          }),
        );
        if (!agent) throw new Refusal('Aucun agent lancé.');
        if (prompt !== null) await instruct(agent, prompt);
        const name = nameOf(agent);
        const warning = deps.usageWarning?.(cli.id) ?? null;
        const launched = `${name} lancé sur ${agent.branch}, port ${String(agent.port)}.`;
        const warnings = [
          ...deps.agents.launchWarnings(agent.id),
          ...(warning === null ? [] : [`${warning}.`]),
        ];
        return reply([launched, ...warnings].join(' '), {
          agent: {
            id: agent.id,
            name,
            role: agent.role,
            model: agent.model,
            branch: agent.branch,
            port: agent.port,
          },
        });
      },
    ),
    tool(
      'close_agent',
      'Ferme un agent : sa tuile disparaît, son worktree et sa branche restent ; seul l’utilisateur peut les supprimer.',
      { agent: agentArgument },
      ['agent'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        await asRefusal(() => deps.agents.close(agent.id, { removeWorktree: false }));
        return reply(`${nameOf(agent)} fermé ; worktree et branche ${agent.branch} gardés.`, {
          closed: true,
          worktreeKept: true,
        });
      },
    ),
    tool(
      'request_integration',
      'Demande à l’utilisateur d’intégrer le travail d’un agent dans la branche principale, avec un message de commit. Rien n’est intégré sans sa confirmation ; l’issue arrive dans tes événements (get_events). Lis get_changes et les tests avant.',
      {
        agent: agentArgument,
        message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE },
        mode: { type: 'string', enum: [...MODES] },
      },
      ['agent', 'message'],
      async (args) => {
        const agent = resolve(stringArg(args, 'agent'));
        const message = stringArg(args, 'message');
        if (message.trim() === '' || message.length > MAX_MESSAGE) {
          throw new Refusal(`Message de 1 à ${String(MAX_MESSAGE)} caractères attendu.`);
        }
        const mode = argument(args, 'mode') ?? 'squash';
        if (mode !== 'squash' && mode !== 'keep-commits') {
          throw new Refusal('Mode « squash » ou « keep-commits » attendu.');
        }
        const request = await deps.requests.request(workspace().id, {
          agentId: agent.id,
          message,
          mode,
        });
        return reply(`Demande d’intégration de ${nameOf(agent)} proposée à l’utilisateur.`, {
          requestId: request.id,
          status: 'waiting-user',
        });
      },
    ),
    tool(
      'wait_for_agents',
      'Attend la fin de tour, une question, une erreur, une fermeture ou l’issue d’une intégration chez les agents donnés (tous par défaut), 60 secondes au plus. Rend 20 événements au plus, résumés à 200 caractères : get_events({ id }) donne le texte entier, et remaining dit ce qui reste. Les agents te réveillent par un pointeur : tu n’as pas besoin d’attendre en boucle.',
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
        const { events, remaining, timedOut, replaced } = await deps.wait(ids, seconds * 1000);
        const names = new Map(workspace().agents.map((a) => [a.id, nameOf(a)]));
        const text = replaced
          ? 'Attente remplacée par une autre.'
          : timedOut
            ? 'Aucun changement.'
            : events
                .map((event) => {
                  const who = event.about ?? event.from;
                  return describe(event, names.get(who) ?? who);
                })
                .join('\n');
        return reply(text, { events, remaining, timedOut });
      },
    ),
    tool(
      'register_issue',
      'Enregistre une issue écrite dans .pact/issues/ de ton worktree : PACT la lit et dit si elle est prête (critères Given/When/Then, aucune question ouverte).',
      {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Relatif à .pact/issues/, ex. 0012-connexion.md.',
        },
      },
      ['path'],
      async (args) => {
        const { issue, missing } = await loopRefusal(() =>
          deps.issues.register(orchestratorId, stringArg(args, 'path')),
        );
        const view = { id: issue.id, title: issue.title, state: issue.state };
        return reply(
          missing.length === 0
            ? `${issue.id} : ${issue.state}.`
            : `${issue.id} : ${issue.state}. Manque : ${missing.join(' ')}`,
          { issue: view, missing },
        );
      },
    ),
    tool(
      'list_issues',
      'Liste les issues du workspace : état, publication, branche, agents et PR.',
      {},
      [],
      () => {
        const issues = deps.issues.list(orchestratorId);
        return Promise.resolve(
          reply(
            issues.map((i) => `${i.id} · ${i.title} · ${i.state}`).join('\n') || 'Aucune issue.',
            {
              issues,
            },
          ),
        );
      },
    ),
    tool(
      'publish_issues',
      'Demande à l’utilisateur de publier des issues prêtes sur le dépôt distant ; rien n’est publié avant sa confirmation. Le résultat arrive dans tes événements (get_events, événement publish).',
      {
        ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 20 },
      },
      ['ids'],
      async (args) => {
        const ids = (args as { ids?: unknown }).ids;
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
          throw new Refusal('Argument « ids » : liste d’identifiants attendue.');
        }
        const request = await loopRefusal(() => deps.issues.requestPublish(orchestratorId, ids));
        return reply(`Demande envoyée à l’utilisateur : ${request.issueIds.join(', ')}.`, {
          requestId: request.id,
          status: 'waiting-user',
        });
      },
    ),
    tool(
      'start_loop',
      'Démarre la boucle dev ↔ test d’une issue prête (3 tours au plus) : PACT compte les tours, valide le verdict du test et fait la preuve par ses propres tests.',
      { issue: { type: 'string', minLength: 1 }, dev: agentArgument, test: agentArgument },
      ['issue', 'dev', 'test'],
      async (args) => {
        const loops = deps.loops;
        const dev = resolve(stringArg(args, 'dev'));
        const test = resolve(stringArg(args, 'test'));
        const issue = stringArg(args, 'issue');
        const loop = await loopRefusal(() =>
          loops.start(workspace().id, { issue, dev: dev.id, test: test.id }),
        );
        return reply(`Boucle de ${issue} démarrée : tour 1/3.`, { loop });
      },
    ),
    tool(
      'next_round',
      'Passe au tour suivant d’une boucle, après un verdict « defects » du test ; refusé au-delà de 3 tours.',
      { issue: { type: 'string', minLength: 1 } },
      ['issue'],
      async (args) => {
        const loops = deps.loops;
        const issue = stringArg(args, 'issue');
        const loop = await loopRefusal(() => loops.next(workspace().id, issue));
        return reply(`${issue} : tour ${String(loop.round)}/3.`, { loop });
      },
    ),
    tool(
      'get_loop',
      'Lit la boucle d’une issue : son tour, ses rapports, la preuve par les tests.',
      { issue: { type: 'string', minLength: 1 } },
      ['issue'],
      (args) => {
        const issue = stringArg(args, 'issue');
        const loop = deps.loops.get(workspace().id, issue);
        if (!loop) throw new Refusal(`Aucune boucle pour ${issue}.`);
        return Promise.resolve(
          reply(`${issue} : tour ${String(loop.round)}/3, ${loop.state}.`, { loop }),
        );
      },
    ),
  ];
}

/** One line per event, for the orchestrator to read. */
function describe(event: EventSummary, name: string): string {
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
    case 'report':
      return `${name} a rendu son rapport : ${event.summary}`;
    case 'question':
      return `${name} pose une question : ${event.summary}`;
    case 'report-missing':
      return `${name} a fini son tour sans rapport.`;
    case 'publish':
      return event.summary;
    default:
      return `${name} : ${event.summary}`;
  }
}

/** 004 FR-006 — the running loop an agent works in, as dev or test. */
const loopOf = (ws: Workspace, agentId: string) => {
  const loop = ws.loops.find(
    (l) => l.state === 'running' && (l.devAgentId === agentId || l.testAgentId === agentId),
  );
  return loop ? { issueId: loop.issueId, round: loop.round } : null;
};
