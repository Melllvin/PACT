import type { Agent, Loop } from '../../shared/model';

/** 006 US3 — where each agent sits on the grid of the « Graphe » view, and how they are linked. */

export type GraphNode = {
  agentId: string;
  column: number;
  row: number;
  /** The issue of the dev ↔ test loop the agent belongs to, if any. */
  group: string | null;
};

export type GraphEdge = {
  from: string;
  to: string;
  kind: 'launched' | 'loop';
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Cells per row; the orchestrator takes the middle one of its row. */
export const GRAPH_COLUMNS = 3;

const byPosition = (a: Agent, b: Agent) => a.position - b.position;

/**
 * The layout, pure (data-model « Graph »): the orchestrator alone on top, then one row per loop
 * that is not closed (dev on the left of its test), then the agents the orchestrator launched, then
 * the others. The nodes come in reading order (row, then column), which is the tab order.
 */
export function graphLayout(agents: readonly Agent[], loops: readonly Loop[]): Graph {
  const known = new Map(agents.map((agent) => [agent.id, agent]));
  const lead = [...agents]
    .sort(byPosition)
    .find((agent) => agent.role === 'orchestrator' && agent.state !== 'closed');

  const nodes: GraphNode[] = [];
  const placed = new Set<string>();
  let row = 0;

  if (lead) {
    nodes.push({ agentId: lead.id, column: Math.floor(GRAPH_COLUMNS / 2), row, group: null });
    placed.add(lead.id);
    row += 1;
  }

  const edges: GraphEdge[] = [];
  const linked = new Set<string>();
  for (const loop of loops) {
    if (loop.state === 'closed') continue;
    const dev = known.get(loop.devAgentId);
    const test = known.get(loop.testAgentId);
    if (!dev || !test || dev.id === test.id) continue;
    if (placed.has(dev.id) || placed.has(test.id)) continue;
    nodes.push({ agentId: dev.id, column: 0, row, group: loop.issueId });
    nodes.push({ agentId: test.id, column: 1, row, group: loop.issueId });
    placed.add(dev.id);
    placed.add(test.id);
    row += 1;
    const key = `${dev.id}:${test.id}`;
    if (!linked.has(key)) {
      linked.add(key);
      edges.push({ from: dev.id, to: test.id, kind: 'loop' });
    }
  }

  const rest = agents.filter((agent) => !placed.has(agent.id)).sort(byPosition);
  const launchedByLead = lead ? rest.filter((agent) => agent.launchedBy === lead.id) : [];
  const others = rest.filter((agent) => !launchedByLead.includes(agent));
  for (const batch of [launchedByLead, others]) {
    batch.forEach((agent, index) => {
      nodes.push({
        agentId: agent.id,
        column: index % GRAPH_COLUMNS,
        row: row + Math.floor(index / GRAPH_COLUMNS),
        group: null,
      });
    });
    row += Math.ceil(batch.length / GRAPH_COLUMNS);
  }

  if (lead) {
    // Every agent the orchestrator launched, in a loop or not, hangs from it.
    for (const node of nodes) {
      const agent = known.get(node.agentId);
      if (agent && agent.id !== lead.id && agent.launchedBy === lead.id) {
        edges.push({ from: lead.id, to: agent.id, kind: 'launched' });
      }
    }
  }
  return { nodes, edges };
}
