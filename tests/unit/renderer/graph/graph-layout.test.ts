import { describe, expect, it } from 'vitest';
import { graphLayout } from '../../../../src/renderer/graph/graph-layout';
import type { Agent, Loop } from '../../../../src/shared/model';
import { agent, uuid } from '../tiles/fixtures';

// 006 T023 — `graphLayout(agents, loops)` (data-model « Graph », research R6): where each agent sits
// on the grid, which group it belongs to, and the links between nodes. Pure: no DOM.

const lead = agent(1, { role: 'orchestrator', state: 'working' });
const dev = agent(2, { role: 'dev', launchedBy: lead.id });
const tester = agent(3, { role: 'test', launchedBy: lead.id });
const spec = agent(4, { role: 'spec', launchedBy: lead.id });
const own = agent(5, { launchedBy: null });

const loop = (overrides: Partial<Loop> = {}): Loop => ({
  issueId: '0012-connexion',
  devAgentId: dev.id,
  testAgentId: tester.id,
  round: 2,
  rounds: [],
  state: 'running',
  escalatedModel: null,
  polish: null,
  ...overrides,
});

const nodeOf = (nodes: ReturnType<typeof graphLayout>['nodes'], a: Agent) => {
  const node = nodes.find((n) => n.agentId === a.id);
  if (!node) throw new Error(`no node for ${a.id}`);
  return node;
};

const launched = (edges: ReturnType<typeof graphLayout>['edges']) =>
  edges.filter((e) => e.kind === 'launched').map((e) => [e.from, e.to]);

describe('graphLayout', () => {
  it('puts one node per agent, each on its own cell of the grid (FR-013)', () => {
    // Given an orchestrator, two agents of a loop, a spec agent and an agent of the user
    // When the layout is computed
    const { nodes } = graphLayout([lead, dev, tester, spec, own], [loop()]);
    // Then there is one node per agent, and two nodes never share a cell
    expect(nodes.map((n) => n.agentId).sort()).toEqual(
      [lead, dev, tester, spec, own].map((a) => a.id).sort(),
    );
    const cells = nodes.map((n) => `${String(n.column)}:${String(n.row)}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('puts the orchestrator at the top, alone on its row (R6)', () => {
    const { nodes } = graphLayout([own, spec, dev, tester, lead], [loop()]);
    const top = nodeOf(nodes, lead);
    for (const other of nodes.filter((n) => n !== top)) {
      expect(other.row).toBeGreaterThan(top.row);
    }
  });

  it('groups the dev and the test of a running loop, side by side, under the issue (US3 scenario 2)', () => {
    const { nodes } = graphLayout([lead, dev, tester, spec, own], [loop()]);
    const d = nodeOf(nodes, dev);
    const t = nodeOf(nodes, tester);
    expect(d.group).toBe('0012-connexion');
    expect(t.group).toBe('0012-connexion');
    expect(d.row).toBe(t.row);
    expect(d.column).toBeLessThan(t.column);
    for (const a of [lead, spec, own]) expect(nodeOf(nodes, a).group).toBeNull();
  });

  it('gives one group per loop that is not closed, passed and escalated ones included', () => {
    const dev2 = agent(6, { role: 'dev', launchedBy: lead.id });
    const test2 = agent(7, { role: 'test', launchedBy: lead.id });
    const { nodes } = graphLayout(
      [lead, dev, tester, dev2, test2],
      [
        loop(),
        loop({
          issueId: '0013-profil',
          devAgentId: dev2.id,
          testAgentId: test2.id,
          state: 'merged',
        }),
      ],
    );
    expect(nodeOf(nodes, dev).group).toBe('0012-connexion');
    expect(nodeOf(nodes, dev2).group).toBe('0013-profil');
    expect(nodeOf(nodes, dev).row).not.toBe(nodeOf(nodes, dev2).row);
  });

  it('ignores a closed loop: no group, no loop link', () => {
    const { nodes, edges } = graphLayout([lead, dev, tester], [loop({ state: 'closed' })]);
    expect(nodeOf(nodes, dev).group).toBeNull();
    expect(nodeOf(nodes, tester).group).toBeNull();
    expect(edges.filter((e) => e.kind === 'loop')).toEqual([]);
  });

  it('orders the nodes: orchestrator, loop groups, agents it launched, then the user’s', () => {
    // The agents come in a scrambled order: the layout does not depend on it.
    const { nodes } = graphLayout([own, spec, tester, lead, dev], [loop()]);
    expect(nodes.map((n) => n.agentId)).toEqual([lead.id, dev.id, tester.id, spec.id, own.id]);
    // The reading order (row, then column) is the same: it is the tab order of the view.
    const reading = [...nodes].sort((a, b) => a.row - b.row || a.column - b.column);
    expect(reading.map((n) => n.agentId)).toEqual(nodes.map((n) => n.agentId));
    expect(nodeOf(nodes, spec).row).toBeGreaterThan(nodeOf(nodes, dev).row);
    expect(nodeOf(nodes, own).row).toBeGreaterThan(nodeOf(nodes, spec).row);
  });

  it('links the orchestrator to each agent it launched, and only those (US3 scenario 1)', () => {
    const { edges } = graphLayout([lead, dev, tester, spec, own], [loop()]);
    expect(launched(edges)).toEqual(
      expect.arrayContaining([
        [lead.id, dev.id],
        [lead.id, tester.id],
        [lead.id, spec.id],
      ]),
    );
    expect(launched(edges)).toHaveLength(3);
  });

  it('links the dev and the test of a loop to each other, once', () => {
    const { edges } = graphLayout([lead, dev, tester], [loop()]);
    const links = edges.filter((e) => e.kind === 'loop');
    expect(links).toHaveLength(1);
    expect(new Set([links[0]?.from, links[0]?.to])).toEqual(new Set([dev.id, tester.id]));
  });

  it('draws no « launched » link without an orchestrator, and lays the nodes flat (scenario 5)', () => {
    // Given agents whose orchestrator is not in the workspace any more
    const orphan = agent(6, { launchedBy: uuid(99) });
    const { nodes, edges } = graphLayout([own, orphan], []);
    // Then nothing is linked, and both agents are laid out
    expect(launched(edges)).toEqual([]);
    expect(nodes).toHaveLength(2);
  });

  it('draws no « launched » link when the orchestrator is closed (data-model « Graph »)', () => {
    const closedLead = { ...lead, state: 'closed' as const };
    const { nodes, edges } = graphLayout([closedLead, dev, spec], []);
    expect(launched(edges)).toEqual([]);
    expect(nodeOf(nodes, dev).group).toBeNull();
    expect(nodeOf(nodes, spec).group).toBeNull();
  });

  it('still groups a loop and links its two agents without an orchestrator', () => {
    const { nodes, edges } = graphLayout([dev, tester], [loop()]);
    expect(nodeOf(nodes, dev).group).toBe('0012-connexion');
    expect(edges).toEqual([expect.objectContaining({ kind: 'loop' })]);
  });

  it('is empty without agent', () => {
    expect(graphLayout([], [])).toEqual({ nodes: [], edges: [] });
  });
});
