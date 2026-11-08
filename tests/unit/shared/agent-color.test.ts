import { describe, expect, it } from 'vitest';
import { agentColor } from '../../../src/shared/agent-color';
import type { Agent } from '../../../src/shared/model';
import { agent } from '../renderer/tiles/fixtures';

// 006 T046 (#46) — the color of a sub-agent is a shade of its orchestrator's.
// Assumed API: `agentColor(agent, agents): string`, a CSS color `hsl(H S% L%)` for an orchestrator
// and its sub-agents; the current `var(--agent-<color>)` for any other agent.

const hue = (color: string): number => {
  const found = /^hsl\(\s*([\d.]+)/.exec(color);
  if (!found) throw new Error(`not an hsl color: ${color}`);
  return Number(found[1]);
};
/** Shortest distance between two hues on the wheel, in degrees. */
const gap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

const lead = (n: number, color: Agent['color']): Agent =>
  agent(n, { role: 'orchestrator', color, cliId: 'claude-code' });
const sub = (n: number, by: Agent, color: Agent['color']): Agent =>
  agent(n, { launchedBy: by.id, color });

describe('agentColor (#46)', () => {
  it('Given an orchestrator and three sub-agents, When colored, Then each sub-agent is in the hue family of its orchestrator (issue #46)', () => {
    const o = lead(1, 'purple');
    const subs = [sub(2, o, 'cyan'), sub(3, o, 'green'), sub(4, o, 'magenta')];
    const all = [o, ...subs];
    for (const s of subs) {
      expect(gap(hue(agentColor(s, all)), hue(agentColor(o, all)))).toBeLessThanOrEqual(30);
    }
  });

  it('Given three sub-agents, When colored, Then they are distinct from each other and from the orchestrator (issue #46)', () => {
    const o = lead(1, 'purple');
    const all = [o, sub(2, o, 'cyan'), sub(3, o, 'green'), sub(4, o, 'magenta')];
    const colors = all.map((a) => agentColor(a, all));
    expect(new Set(colors).size).toBe(4);
  });

  it('Given the same workspace, When colored twice, Then the result is the same (derived, never stored)', () => {
    const o = lead(1, 'purple');
    const all = [o, sub(2, o, 'cyan'), sub(3, o, 'green')];
    expect(all.map((a) => agentColor(a, all))).toEqual(all.map((a) => agentColor(a, all)));
  });

  it('Given two orchestrators, When colored, Then their families are far apart (issue #46)', () => {
    const a = lead(1, 'purple');
    const b = lead(2, 'cyan');
    const all = [a, b, sub(3, a, 'green'), sub(4, b, 'magenta')];
    const [h1, h2] = [hue(agentColor(a, all)), hue(agentColor(b, all))];
    expect(gap(h1, h2)).toBeGreaterThanOrEqual(60);
    // Their sub-agents stay with their own orchestrator, not the other.
    const s1 = hue(agentColor(all[2] as Agent, all));
    const s2 = hue(agentColor(all[3] as Agent, all));
    expect(gap(s1, h1)).toBeLessThan(gap(s1, h2));
    expect(gap(s2, h2)).toBeLessThan(gap(s2, h1));
  });

  it('Given an agent launched by the user, When colored, Then it keeps its current color (issue #46)', () => {
    const o = lead(1, 'purple');
    const own = agent(2, { color: 'green', launchedBy: null });
    expect(agentColor(own, [o, own])).toBe('var(--agent-green)');
  });

  it('Given a workspace without orchestrator, When colored, Then every agent keeps its current color', () => {
    const all = [agent(1, { color: 'purple' }), agent(2, { color: 'cyan' })];
    expect(all.map((a) => agentColor(a, all))).toEqual([
      'var(--agent-purple)',
      'var(--agent-cyan)',
    ]);
  });

  it('Given a sub-agent whose orchestrator is gone, When colored, Then it keeps its current color', () => {
    const orphan = agent(2, { color: 'yellow', launchedBy: agent(9).id });
    expect(agentColor(orphan, [orphan])).toBe('var(--agent-yellow)');
  });
});
