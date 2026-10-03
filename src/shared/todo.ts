import type { Agent, TileAction, TodoItem, TodoKind, Workspace } from './model';

const ORDER: TodoKind[] = ['answer', 'rate-limit', 'review', 'prompt', 'info'];

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
  workspace: Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch'>,
  names: (cliId: string) => string,
  /** The agents with changes to review (`review:pending`). */
  toReview: readonly string[] = [],
): TodoItem[] {
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  const todos = agents.flatMap(
    (agent) => agentTodo(agent, names(agent.cliId), toReview.includes(agent.id)) ?? [],
  );
  const terminals = workspace.freeTerminals.map((terminal): TodoItem => ({
    id: `${terminal.id}:info`,
    agentId: terminal.id,
    kind: 'info',
    title: `En cours ▸ ${shellName(terminal.shell)} — ${workspace.mainBranch}`,
    actions: [],
  }));
  // Array.prototype.sort is stable: the tile order holds within a kind.
  return [...todos, ...terminals].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
