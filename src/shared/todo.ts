import { agentName } from './agent-name';
import { MAX_REBASES_IN_A_ROW } from './delivery';
import type { Agent, Loop, TileAction, TodoItem, TodoKind, Workspace } from './model';
import { clockTime, usageAlert, type UsageState, type UsageThresholds } from './usage';

// 008 data-model: the local merges awaiting the user come after the answers, before the reviews.
export const ORDER: TodoKind[] = [
  'answer',
  'decide',
  'delivery-local',
  'delivery-review',
  'delivery-silent-ci',
  'delivery-alert',
  'publish-issues',
  'loop-escalated',
  'exchange-escalated',
  'rate-limit',
  'usage-limit',
  'wake-held',
  'review',
  'prompt',
  'info',
];

const plural = (count: number, word: string) => `${String(count)} ${word}${count > 1 ? 's' : ''}`;

/** « <CLI> <number> · <role> »: which agent, and what it does. */
const who = (agent: Agent, cli: string) =>
  [agentName(agent, () => cli), ...(agent.role ? [agent.role] : [])].join(' · ');

/** Who gets no « Changements à relire »: the orchestrator, and the agents of a loop until it ends. */
function reviewedLater(agent: Agent, loops: readonly Loop[]): boolean {
  if (agent.role === 'orchestrator') return true;
  return loops.some(
    (loop) =>
      loop.testAgentId === agent.id ||
      (loop.devAgentId === agent.id &&
        (loop.state === 'running' ||
          loop.state === 'escalated' ||
          loop.state === 'polishing' ||
          loop.state === 'delivering')),
  );
}

/** What an agent needs from the user, if anything, with the same actions as its tile (FR-028). */
function agentTodo(
  agent: Agent,
  cli: string,
  files: number | undefined,
  loops: readonly Loop[],
  /** 007 FR-029 — an orchestrator able to take the questions: they do not go to the user. */
  routed = false,
): TodoItem | null {
  const item = (kind: TodoKind, title: string, actions: TileAction[]): TodoItem => ({
    id: `${agent.id}:${kind}`,
    agentId: agent.id,
    kind,
    title,
    actions,
  });
  if (agent.state === 'awaiting-answer') {
    const question = agent.awaiting === 'question';
    return item('answer', '◆ Répondre', question ? ['open-terminal'] : ['allow', 'deny']);
  }
  // A blocked report with questions, once the agent stopped: the user decides.
  const ready = agent.state === 'done' || agent.state === 'awaiting-prompt';
  const report = agent.lastReport;
  if (ready && !routed && report?.status === 'blocked' && report.questions.length > 0) {
    return {
      ...item(
        'decide',
        `◆ Décider · ${who(agent, cli)} · ${plural(report.questions.length, 'question')}`,
        [],
      ),
      decide: { questions: report.questions },
    };
  }
  if (agent.state === 'error' && agent.lastError?.kind === 'rate-limit') {
    return item('rate-limit', `✕ Limite de débit · ${cli}`, ['log', 'restart', 'resume']);
  }
  // 002 FR-002: done with changes; its review comes before a new prompt. A pending list that
  // lags behind a state change offers nothing to an agent working again.
  if (files !== undefined && ready && !reviewedLater(agent, loops)) {
    const size = files > 0 ? [plural(files, 'fichier')] : [];
    return item('review', ['Changements à relire', who(agent, cli), ...size].join(' · '), [
      'review',
    ]);
  }
  if (agent.state === 'awaiting-prompt') {
    return item('prompt', `Donner une consigne · ${cli} · tapez dans le terminal`, []);
  }
  return null;
}

/** 007 FR-014, FR-016 — « ◆ Réveil en attente »: a wake held back and said, on the row of its agent. */
function wakeHeld(agent: Agent, cli: string): TodoItem | null {
  if (!agent.wakeNotice || agent.state === 'closed') return null;
  const input = agent.wakeNotice === 'input';
  return {
    id: `${agent.id}:wake-held`,
    agentId: agent.id,
    kind: 'wake-held',
    title: `◆ Réveil en attente · ${who(agent, cli)} · ${input ? 'saisie en cours' : 'plafond atteint'}`,
    actions: input ? ['open-terminal'] : [],
    detail: input
      ? 'Videz l’invite ou envoyez votre saisie.'
      : '20 réveils cette heure : les événements restent lisibles.',
  };
}

/** `/bin/zsh` → zsh, `C:\…\pwsh.exe` → pwsh. */
const shellName = (path: string) => path.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

/** The À faire items of a workspace, derived and never stored (data-model TodoItem, FR-027). */
export function deriveTodos(
  workspace: Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch'> &
    Partial<Pick<Workspace, 'deliveries' | 'loops' | 'issues' | 'publishRequests' | 'exchanges'>>,
  names: (cliId: string) => string,
  /** The agents with changes to review, with their number of changed files (`review:pending`). */
  toReview: Readonly<Record<string, number>> | readonly never[] = {},
  /** 005 — the usage of the CLI accounts, read with the thresholds at `now`. */
  usage?: { states: readonly UsageState[]; thresholds: UsageThresholds; now: Date },
): TodoItem[] {
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  // 007 R9 — with an orchestrator that is not in error, the questions of the others go to it.
  const lead = agents.find((agent) => agent.role === 'orchestrator');
  const todos = agents.flatMap(
    (agent) =>
      agentTodo(
        agent,
        names(agent.cliId),
        (toReview as Readonly<Record<string, number | undefined>>)[agent.id],
        workspace.loops ?? [],
        lead !== undefined && lead.state !== 'error' && agent.id !== lead.id,
      ) ?? [],
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  // « ◎ Fusionner <agent> → <main> ? »: a project without a remote, the user decides (008 FR-008).
  // « ◎ Relire la PR #n »: the PR of a request that asks for the eyes of the user (008 data-model).
  const requests = (workspace.deliveries ?? []).flatMap((delivery): TodoItem[] => {
    const agent = byId.get(delivery.agentId);
    if (!agent) return [];
    if (delivery.channel === 'github') {
      const { pr } = delivery;
      if (!pr) return [];
      const sha = delivery.pushedHead ?? delivery.frozenCommit;
      const label = delivery.issueId ?? delivery.branch;
      const watching = delivery.state === 'watching';
      const item = (kind: TodoKind, title: string, verdict?: 'accepted' | null): TodoItem => ({
        id: `${delivery.id}:${kind}`,
        agentId: agent.id,
        kind,
        title,
        actions: [],
        delivery: {
          id: delivery.id,
          head: sha,
          url: pr.url,
          ...(verdict === undefined ? {} : { verdict }),
        },
      });
      const items: TodoItem[] = [];
      // 008 US4 — « ◆ CI muette »: a configured CI that shows no check for 10 min (FR-016), on this head.
      if (watching && delivery.ci?.verdict === 'silent' && delivery.ci.head === sha) {
        items.push(
          item('delivery-silent-ci', `◆ CI muette · PR #${String(pr.number)} · 10 min sans check`),
        );
      }
      // « ◆ Livraison »: the PR was brought up to date again and again (FR-017), the user is told.
      if (
        (watching || delivery.state === 'reviewing') &&
        delivery.rebases >= MAX_REBASES_IN_A_ROW
      ) {
        items.push(
          item(
            'delivery-alert',
            `◆ Livraison · ${label} · ${String(delivery.rebases)} recalages de suite`,
          ),
        );
      }
      // Asked while it is watched (a PR without a verdict), or once the CI turned green and Auto does not merge.
      if ((watching && delivery.review.required) || delivery.state === 'reviewing') {
        items.push(
          item(
            'delivery-review',
            `◎ Relire la PR #${String(pr.number)} · ${label} · ${sha.slice(0, 7)}${delivery.unverified ? ' · sans verdict' : ''}`,
            delivery.unverified ? null : 'accepted',
          ),
        );
      }
      return items;
    }
    if (delivery.state !== 'reviewing') return [];
    const name = agentName(agent, names);
    return [
      {
        id: `${delivery.id}:delivery-local`,
        agentId: agent.id,
        kind: 'delivery-local',
        title: `◎ Fusionner ${name} → ${workspace.mainBranch} ?${delivery.unverified ? ' · sans verdict' : ''}`,
        actions: [],
        delivery: { id: delivery.id, head: delivery.frozenCommit },
      },
    ];
  });
  // « ◎ Créer N issues ? »: nothing leaves the machine before the user says so (004 FR-023).
  const publish = lead
    ? (workspace.publishRequests ?? []).map((request): TodoItem => {
        const titles = request.issueIds.map(
          (id) => (workspace.issues ?? []).find((issue) => issue.id === id)?.title ?? id,
        );
        const count = request.issueIds.length;
        const name = agentName(lead, names);
        return {
          id: `${request.id}:publish-issues`,
          agentId: lead.id,
          kind: 'publish-issues',
          title: `◎ Créer ${String(count)} issue${count > 1 ? 's' : ''} ? · ${name} · ${titles.join(', ')}`,
          actions: [],
          publish: { requestId: request.id },
        };
      })
    : [];
  // « ✕ Boucle arrêtée »: the ceiling of the project without the tests passing, the user decides (004 FR-018).
  // 008 US5 sc.7 — the ceiling is the project's; a workspace without settings has the default.
  const maxRounds = (workspace as Partial<Workspace>).delivery?.maxRounds ?? 3;
  const loops = (workspace.loops ?? []).flatMap((loop): TodoItem[] => {
    const dev = byId.get(loop.devAgentId);
    return loop.state === 'escalated' && dev
      ? [
          {
            id: `${loop.issueId}:loop-escalated`,
            agentId: loop.devAgentId,
            kind: 'loop-escalated',
            title: `✕ Boucle arrêtée · ${loop.issueId} · ${String(maxRounds)} tours`,
            actions: [],
            loop: { issueId: loop.issueId, maxRounds },
          },
        ]
      : [];
  });
  // « ✕ Échanges en boucle »: two agents bounced a message 3 times without a commit (007 FR-006).
  const exchanges = (workspace.exchanges?.escalations ?? []).flatMap((escalation): TodoItem[] => {
    if (escalation.state !== 'pending') return [];
    const pair = escalation.agents.flatMap((id) => byId.get(id) ?? []);
    if (pair.length !== 2) return [];
    const [first, second] = pair.sort((a, b) => a.position - b.position) as [Agent, Agent];
    const last = workspace.exchanges?.messages.find((m) => m.id === escalation.lastMessageId);
    const name = (a: Agent) => agentName(a, names);
    return [
      {
        id: `${escalation.id}:exchange-escalated`,
        agentId: first.id,
        kind: 'exchange-escalated',
        title: `✕ Échanges en boucle · ${name(first)} ↔ ${name(second)} · 3 allers-retours`,
        actions: [],
        exchange: { escalationId: escalation.id, text: last?.text ?? '' },
      },
    ];
  });
  const terminals = workspace.freeTerminals.map((terminal): TodoItem => ({
    id: `${terminal.id}:info`,
    agentId: terminal.id,
    kind: 'info',
    title: `En cours ▸ ${shellName(terminal.shell)} — ${workspace.mainBranch}`,
    actions: [],
  }));
  const limits = usage ? usageTodos(workspace, names, usage) : [];
  // Array.prototype.sort is stable: the tile order holds within a kind.
  const held = agents.flatMap((agent) => wakeHeld(agent, names(agent.cliId)) ?? []);
  return [
    ...todos,
    ...held,
    ...requests,
    ...publish,
    ...loops,
    ...exchanges,
    ...limits,
    ...terminals,
  ].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/**
 * 005 FR-011 — « ◆ Limite <CLI> à <N> % · <fenêtre> · réinitialisation <heure> »: one per account
 * of a CLI of the workspace near its limit, the same item from 80 to 95 %, gone below the first
 * threshold.
 */
function usageTodos(
  workspace: Pick<Workspace, 'agents'>,
  names: (cliId: string) => string,
  {
    states,
    thresholds,
    now,
  }: { states: readonly UsageState[]; thresholds: UsageThresholds; now: Date },
): TodoItem[] {
  // A closed agent uses no quota: its CLI alone raises no alert (006).
  const clis = new Set(
    workspace.agents.filter((agent) => agent.state !== 'closed').map((agent) => agent.cliId),
  );
  return states.flatMap((state): TodoItem[] => {
    const alert = clis.has(state.cliId) ? usageAlert(state, thresholds, now) : null;
    if (!alert) return [];
    const key = `usage:${state.cliId}:${state.account}`;
    const reset = alert.window.resetsAt === null ? 'inconnue' : clockTime(alert.window.resetsAt);
    return [
      {
        id: `${key}:usage-limit`,
        agentId: key,
        kind: 'usage-limit',
        title: `◆ Limite ${names(state.cliId)} à ${String(alert.percent)} % · ${alert.window.label} · réinitialisation ${reset}`,
        actions: [],
        usage: { cliId: state.cliId, account: state.account, level: alert.level },
      },
    ];
  });
}
