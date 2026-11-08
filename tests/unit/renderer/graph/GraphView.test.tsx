import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GraphView } from '../../../../src/renderer/graph/GraphView';
import type { Agent, Loop } from '../../../../src/shared/model';
import { agentColor } from '../../../../src/shared/agent-color';
import { agent } from '../tiles/fixtures';

// 006 T024 — the « Graphe » view (contracts/ui.md « Graphe », FR-013 to FR-019): a region, a list of
// nodes that are buttons, a group per loop, decorative links; Focus on click, Enter or Space.

const lead = agent(1, { role: 'orchestrator', state: 'working' });
const dev = agent(2, { role: 'dev', state: 'working', launchedBy: lead.id });
const tester = agent(3, { role: 'test', state: 'awaiting-prompt', launchedBy: lead.id });
const spec = agent(4, { role: 'spec', state: 'awaiting-prompt', launchedBy: lead.id });
const own = agent(5, { state: 'done', launchedBy: null });

const loop: Loop = {
  issueId: '0012-connexion',
  devAgentId: dev.id,
  testAgentId: tester.id,
  round: 2,
  rounds: [],
  state: 'running',
  escalatedModel: null,
};

const names = () => 'Claude Code';
const now = new Date('2030-01-01T08:00:00.000Z');

const setup = (agents: Agent[] = [lead, dev, tester, spec, own], loops: Loop[] = [loop]) => {
  const onOpen = vi.fn();
  const ui = (list: Agent[], l: Loop[]) => (
    <GraphView agents={list} loops={l} names={names} now={now} onOpen={onOpen} />
  );
  const view = render(ui(agents, loops));
  const rerender = (list: Agent[], l: Loop[] = loops) => {
    view.rerender(ui(list, l));
  };
  return { onOpen, rerender };
};

const nodes = () => within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('button');

describe('GraphView', () => {
  it('is a region « Graphe des agents »', () => {
    setup();
    expect(screen.getByRole('region', { name: 'Graphe des agents' })).toBeDefined();
  });

  it('lists one button per agent in « Agents », named with all it knows (FR-018, scenario 6)', () => {
    // Given an orchestrator, a loop at round 2, a spec agent and an agent of the user
    setup();
    // Then each node says its name, role, state, phase and issue, and who launched it
    expect(nodes().map((node) => node.getAttribute('aria-label') ?? node.textContent)).toEqual([
      'Claude Code 1, orchestrateur, travaille, lancé par vous',
      'Claude Code 2, dev, travaille, dev ↔ test 2/3, issue 0012-connexion, lancé par Claude Code 1',
      'Claude Code 3, test, attend une consigne, dev ↔ test 2/3, issue 0012-connexion, lancé par Claude Code 1',
      'Claude Code 4, spec, attend une consigne, spec, lancé par Claude Code 1',
      'Claude Code 5, fini, lancé par vous',
    ]);
  });

  it('puts one listitem per agent in the list', () => {
    setup();
    const list = screen.getByRole('list', { name: 'Agents' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(nodes()).toHaveLength(5);
  });

  it('groups the two agents of a loop under « Issue <id> · dev ↔ test <n>/3 » (scenario 2)', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Issue 0012-connexion · dev ↔ test 2/3' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      expect.stringMatching(/^Claude Code 2, dev, /),
      expect.stringMatching(/^Claude Code 3, test, /),
    ]);
  });

  it('has no group without a loop', () => {
    setup([lead, spec, own], []);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('hides its links from assistive technology: every svg is aria-hidden (contracts/ui.md)', () => {
    const { container } = render(
      <GraphView
        agents={[lead, dev, tester]}
        loops={[loop]}
        names={names}
        now={now}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
  });

  it('draws no link when nothing is linked: agents without orchestrator nor loop (scenario 5)', () => {
    const { container } = render(
      <GraphView
        agents={[own, agent(6, { state: 'working' })]}
        loops={[]}
        names={names}
        now={now}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('svg line, svg path, svg polyline')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens the Focus of an agent on a click (scenario 4)', async () => {
    const { onOpen } = setup();
    await userEvent.click(screen.getByRole('button', { name: /^Claude Code 3, test, / }));
    expect(onOpen).toHaveBeenCalledWith(tester.id);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('opens the Focus of an agent on %s (FR-018, scenario 4)', async (_name, key) => {
    const { onOpen } = setup();
    screen.getByRole('button', { name: /^Claude Code 4, spec, / }).focus();
    await userEvent.keyboard(key);
    expect(onOpen).toHaveBeenCalledWith(spec.id);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('tabs through the nodes in reading order: orchestrator, loop, launched, then the user’s', async () => {
    setup();
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      seen.push(document.activeElement?.getAttribute('aria-label')?.split(',')[0] ?? '');
    }
    expect(seen).toEqual([
      'Claude Code 1',
      'Claude Code 2',
      'Claude Code 3',
      'Claude Code 4',
      'Claude Code 5',
    ]);
  });

  it('follows an agent that changes state: its node is renamed (scenario 3, FR-016)', () => {
    const { rerender } = setup();
    expect(
      screen.getByRole('button', { name: /^Claude Code 4, spec, attend une consigne/ }),
    ).toBeDefined();
    rerender([lead, dev, tester, { ...spec, state: 'awaiting-answer' }, own]);
    expect(
      screen.getByRole('button', { name: /^Claude Code 4, spec, attend une réponse/ }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: /^Claude Code 4, spec, attend une consigne/ }),
    ).toBeNull();
  });

  it('follows the loop: the group takes the new round (scenario 2)', () => {
    const { rerender } = setup();
    rerender([lead, dev, tester, spec, own], [{ ...loop, round: 3 }]);
    expect(
      screen.getByRole('group', { name: 'Issue 0012-connexion · dev ↔ test 3/3' }),
    ).toBeDefined();
    expect(screen.queryByRole('group', { name: /dev ↔ test 2\/3/ })).toBeNull();
  });

  it('follows an agent that is launched: a node is added (FR-016)', () => {
    const { rerender } = setup([lead], []);
    expect(nodes()).toHaveLength(1);
    rerender([lead, spec], []);
    expect(nodes()).toHaveLength(2);
  });

  it('does not offer any action on a node: only the button that opens it (FR-019)', () => {
    setup();
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('shows a renamed agent under its name, in its node and in « lancé par » (T045)', () => {
    // Given the orchestrator renamed « Cheffe » and a dev renamed « Zoé »
    const boss = { ...lead, name: 'Cheffe' };
    const renamed = { ...dev, name: 'Zoé' };
    setup([boss, renamed], []);
    // Then the nodes carry the new names, and the dev is launched by « Cheffe »
    expect(nodes().map((node) => node.getAttribute('aria-label'))).toEqual([
      'Cheffe, orchestrateur, travaille, lancé par vous',
      'Zoé, dev, travaille, lancé par Cheffe',
    ]);
    expect(screen.getByText('Zoé')).toBeDefined();
  });

  it('takes the color of agentColor for the node (T050)', () => {
    // Given an orchestrator and a dev
    const agents = [lead, dev];
    setup(agents, []);
    // Then each node carries the derived color, not the stored base color
    const colors = nodes().map((node) => node.style.getPropertyValue('--agent-color'));
    expect(colors).toEqual(agents.map((a) => agentColor(a, agents)));
    expect(colors[0]).not.toBe('var(--agent-purple)');
  });
});
