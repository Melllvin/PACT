import type { Agent, TileAction, TodoItem, TodoKind, Workspace } from './model';
import { clockTime, usageAlert, type UsageState, type UsageThresholds } from './usage';

// 003 data-model: the integrations asked for come after the answers, before the reviews.
const ORDER: TodoKind[] = [
  'answer',
  'integration-request',
  'publish-issues',
  'loop-escalated',
  'rate-limit',
  'usage-limit',
  'review',
  'prompt',
  'info',
];

/** What an agent needs from the user, if anything, with the same actions as its tile (FR-028). */
function agentTodo(agent: Agent, cli: string, toReview: boolean): TodoItem | null {
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
  if (agent.state === 'error' && agent.lastError?.kind === 'rate-limit') {
    return item('rate-limit', `✕ Limite de débit · ${cli}`, ['log', 'restart', 'resume']);
  }
  // 002 FR-002: done with changes; its review comes before a new prompt. A pending list that
  // lags behind a state change offers nothing to an agent working again.
  const ready = agent.state === 'done' || agent.state === 'awaiting-prompt';
  if (toReview && ready) return item('review', `Changements à relire · ${cli}`, ['review']);
  if (agent.state === 'awaiting-prompt') {
    return item('prompt', `Donner une consigne · ${cli} · tapez dans le terminal`, []);
  }
  return null;
}

/** `/bin/zsh` → zsh, `C:\…\pwsh.exe` → pwsh. */
const shellName = (path: string) => path.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

/** The À faire items of a workspace, derived and never stored (data-model TodoItem, FR-027). */
export function deriveTodos(
  workspace: Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch'> &
    Partial<Pick<Workspace, 'integrationRequests' | 'loops' | 'issues' | 'publishRequests'>>,
  names: (cliId: string) => string,
  /** The agents with changes to review (`review:pending`). */
  toReview: readonly string[] = [],
  /** 005 — the usage of the CLI accounts, read with the thresholds at `now`. */
  usage?: { states: readonly UsageState[]; thresholds: UsageThresholds; now: Date },
): TodoItem[] {
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  const todos = agents.flatMap(
    (agent) => agentTodo(agent, names(agent.cliId), toReview.includes(agent.id)) ?? [],
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  // « ◎ Intégrer <agent> → <main> ? »: the orchestrator asks, the user decides (003 FR-017).
  const requests = (workspace.integrationRequests ?? []).flatMap((request): TodoItem[] => {
    const agent = byId.get(request.agentId);
    if (!agent) return [];
    const name = `${names(agent.cliId)} ${String(agent.position)}`;
    return [
      {
        id: `${request.id}:integration-request`,
        agentId: agent.id,
        kind: 'integration-request',
        title: `◎ Intégrer ${name} → ${workspace.mainBranch} ?`,
        actions: [],
        request: { id: request.id, message: request.message },
      },
    ];
  });
  // « ◎ Créer N issues ? »: nothing leaves the machine before the user says so (004 FR-023).
  const lead = agents.find((agent) => agent.role === 'orchestrator');
  const publish = lead
    ? (workspace.publishRequests ?? []).map((request): TodoItem => {
        const titles = request.issueIds.map(
          (id) => (workspace.issues ?? []).find((issue) => issue.id === id)?.title ?? id,
        );
        const count = request.issueIds.length;
        const name = `${names(lead.cliId)} ${String(lead.position)}`;
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
  // « ✕ Boucle arrêtée »: 3 rounds without the tests passing, the user decides (004 FR-018).
  const loops = (workspace.loops ?? []).flatMap((loop): TodoItem[] =>
    loop.state === 'escalated' && byId.has(loop.devAgentId)
      ? [
          {
            id: `${loop.issueId}:loop-escalated`,
            agentId: loop.devAgentId,
            kind: 'loop-escalated',
            title: `✕ Boucle arrêtée · ${loop.issueId} · 3 tours`,
            actions: [],
            loop: { issueId: loop.issueId },
          },
        ]
      : [],
  );
  const terminals = workspace.freeTerminals.map((terminal): TodoItem => ({
    id: `${terminal.id}:info`,
    agentId: terminal.id,
    kind: 'info',
    title: `En cours ▸ ${shellName(terminal.shell)} — ${workspace.mainBranch}`,
    actions: [],
  }));
  const limits = usage ? usageTodos(workspace, names, usage) : [];
  // Array.prototype.sort is stable: the tile order holds within a kind.
  return [...todos, ...requests, ...publish, ...loops, ...limits, ...terminals].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
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
  const clis = new Set(workspace.agents.map((agent) => agent.cliId));
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
