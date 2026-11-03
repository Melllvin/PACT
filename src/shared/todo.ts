import type { Agent, TileAction, TodoItem, TodoKind, Workspace } from './model';

/** 004 FR-021 — two agents change the same files (`review:pending`). */
type Overlap = { agents: readonly [string, string]; files: readonly string[] };

// 003 data-model: the integrations asked for come after the answers, before the reviews.
const ORDER: TodoKind[] = [
  'answer',
  'integration-request',
  'loop-escalated',
  'overlap',
  'rate-limit',
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
  if (agent.state === 'awaiting-answer') return item('answer', '◆ Répondre', ['allow', 'deny']);
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
const shellName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.exe$/i, '');

/** The À faire items of a workspace, derived and never stored (data-model TodoItem, FR-027). */
export function deriveTodos(
  workspace: Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch'> &
    Partial<Pick<Workspace, 'integrationRequests' | 'loops'>>,
  names: (cliId: string) => string,
  /** The agents with changes to review (`review:pending`). */
  toReview: readonly string[] = [],
  overlaps: readonly Overlap[] = [],
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
  // « ⚠ Fichiers communs »: two agents change the same files (004 FR-021).
  const common = overlaps.flatMap((overlap): TodoItem[] => {
    const both = overlap.agents.flatMap((id) => byId.get(id) ?? []);
    if (both.length < 2) return [];
    const who = both.map((agent) => `${names(agent.cliId)} ${String(agent.position)}`);
    return [
      {
        id: `${overlap.agents.join('+')}:overlap`,
        agentId: overlap.agents[0],
        kind: 'overlap',
        title: `⚠ Fichiers communs · ${who.join(', ')} · ${overlap.files.join(', ')}`,
        actions: [],
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
  // Array.prototype.sort is stable: the tile order holds within a kind.
  return [...todos, ...requests, ...loops, ...common, ...terminals].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
}
