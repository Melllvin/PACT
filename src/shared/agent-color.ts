import type { Agent } from './model';

/** The hue (degrees) of each base color of an agent, as in the theme. */
const HUES: Record<Agent['color'], number> = {
  purple: 265,
  cyan: 190,
  green: 145,
  magenta: 320,
  yellow: 50,
  slate: 215,
};

/** Sub-agents spread over ± this many degrees around the hue of their orchestrator. */
const SPREAD = 24;

const hsl = (hue: number, saturation: number, lightness: number) =>
  `hsl(${String(Math.round(((hue % 360) + 360) % 360))} ${String(saturation)}% ${String(lightness)}%)`;

/**
 * 006 #46 — the color of an agent. An orchestrator and its sub-agents share a hue family, the
 * sub-agents each in a shade of their own; two orchestrators get families far apart. Any other
 * agent keeps its color. Derived from the agents, never stored.
 */
export function agentColor(agent: Agent, agents: readonly Agent[]): string {
  const own = `var(--agent-${agent.color})`;
  const leads = agents.filter((a) => a.role === 'orchestrator').sort(byPosition);
  const family = (lead: Agent) => {
    // Orchestrators are spread evenly on the wheel, the first on the hue of its own color.
    const index = leads.indexOf(lead);
    const base = HUES[leads[0]?.color ?? lead.color];
    return base + (360 / Math.max(leads.length, 1)) * index;
  };
  if (agent.role === 'orchestrator') return hsl(family(agent), 80, 66);
  const lead = leads.find((l) => l.id === agent.launchedBy);
  if (!lead) return own;
  const subs = agents.filter((a) => a.launchedBy === lead.id).sort(byPosition);
  const slot = subs.indexOf(agent);
  // Evenly from −SPREAD to +SPREAD; the lightness also moves, so close hues stay apart.
  const share = subs.length > 1 ? slot / (subs.length - 1) : 0.5;
  const shift = (share - 0.5) * 2 * SPREAD;
  return hsl(family(lead) + (shift === 0 ? SPREAD / 2 : shift), 70, 56 + (slot % 2) * 10);
}

const byPosition = (a: Agent, b: Agent) => a.position - b.position;
