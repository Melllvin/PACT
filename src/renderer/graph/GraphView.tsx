import type { CSSProperties, ReactNode } from 'react';
import type { Agent, Loop } from '../../shared/model';
import { LOOP_ROUNDS, ROLE_LABELS, agentPhase, agentStateLabel } from '../../shared/agents-view';
import { graphLayout, type GraphNode } from './graph-layout';

type Props = {
  agents: readonly Agent[];
  loops: readonly Loop[];
  names: (cliId: string) => string;
  now: Date;
  /** Opens the Focus of the agent. */
  onOpen: (agentId: string) => void;
};

// Fixed cells: the links of the decorative svg are computed from them, not measured.
const CELL_W = 232;
const CELL_H = 76;
const GAP_X = 36;
const GAP_Y = 60;

const x = (column: number) => column * (CELL_W + GAP_X);
const y = (row: number) => row * (CELL_H + GAP_Y);

const STATE_COLORS: Partial<Record<Agent['state'], string>> = {
  'awaiting-answer': 'var(--waiting)',
  done: 'var(--accept)',
  error: 'var(--danger)',
};

const SEPARATOR = ', ';

/**
 * 006 US3 — the « Graphe » view (contracts/ui.md): the orchestrator on top, the loops as groups, the
 * other agents below. Each node is a button that opens the Focus of its agent; the links are a
 * decorative svg, hidden from assistive technologies.
 */
export function GraphView({ agents, loops, names, now, onOpen }: Props) {
  const { nodes, edges } = graphLayout(agents, loops);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const nameOf = (agent: Agent) => `${names(agent.cliId)} ${String(agent.position)}`;
  const at = new Map(nodes.map((node) => [node.agentId, node]));

  const columns = Math.max(0, ...nodes.map((node) => node.column + 1));
  const rows = Math.max(0, ...nodes.map((node) => node.row + 1));
  const width = columns * CELL_W + Math.max(0, columns - 1) * GAP_X;
  const height = rows * CELL_H + Math.max(0, rows - 1) * GAP_Y;

  const node = (graphNode: GraphNode) => {
    const agent = byId.get(graphNode.agentId);
    if (!agent) return null;
    const phase = agentPhase(agent, loops);
    const phaseLabel = phase
      ? phase.round
        ? `${phase.label} ${String(phase.round.n)}/${String(phase.round.max)}`
        : phase.label
      : null;
    const launcher = agent.launchedBy ? byId.get(agent.launchedBy) : undefined;
    const stateLabel = agentStateLabel(agent, now);
    const label = [
      nameOf(agent),
      ...(agent.role ? [ROLE_LABELS[agent.role]] : []),
      stateLabel,
      ...(phaseLabel ? [phaseLabel] : []),
      ...(phase?.issueId ? [`issue ${phase.issueId}`] : []),
      `lancé par ${launcher ? nameOf(launcher) : 'vous'}`,
    ].join(SEPARATOR);
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          onOpen(agent.id);
        }}
        style={
          {
            '--agent-color': `var(--agent-${agent.color})`,
            width: CELL_W,
            height: CELL_H,
          } as CSSProperties
        }
        className="relative z-10 flex flex-col justify-center gap-1 rounded-xl border border-white/6 bg-surface px-3 text-left text-[13px] outline-none hover:border-(--agent-color)/60 focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            style={{ background: STATE_COLORS[agent.state] ?? 'var(--agent-color)' }}
            className="inline-block size-[7px] flex-none rounded-full"
          />
          <span className="truncate">{nameOf(agent)}</span>
          {agent.role && (
            <>
              {' '}
              <span className="ml-auto flex-none font-mono text-[11px] text-[#a1a1aa]">
                {ROLE_LABELS[agent.role]}
              </span>
            </>
          )}
        </span>{' '}
        <span className="truncate text-[12px] text-[#a1a1aa]">
          {[stateLabel, ...(phaseLabel ? [phaseLabel] : [])].join(', ')}
        </span>
      </button>
    );
  };

  // The group of a loop is one listitem of the list, holding the list of its two nodes.
  const items: ReactNode[] = [];
  const done = new Set<string>();
  for (const graphNode of nodes) {
    if (done.has(graphNode.agentId)) continue;
    const place: CSSProperties = {
      gridColumn: graphNode.column + 1,
      gridRow: graphNode.row + 1,
    };
    if (graphNode.group === null) {
      done.add(graphNode.agentId);
      items.push(
        <li key={graphNode.agentId} style={place} className="m-0 p-0">
          {node(graphNode)}
        </li>,
      );
      continue;
    }
    const members = nodes.filter((n) => n.group === graphNode.group);
    for (const member of members) done.add(member.agentId);
    const loop = loops.find((l) => l.issueId === graphNode.group && l.state !== 'closed');
    const title = `Issue ${graphNode.group} · dev ↔ test ${String(loop?.round ?? 1)}/${String(LOOP_ROUNDS)}`;
    items.push(
      <li
        key={`group:${graphNode.group}`}
        style={{
          ...place,
          gridColumn: `${String(graphNode.column + 1)} / span ${String(members.length)}`,
        }}
        className="m-0 p-0"
      >
        <div
          role="group"
          aria-label={title}
          className="relative rounded-2xl outline-1 outline-offset-[6px] outline-dashed outline-white/12"
        >
          <span
            aria-hidden
            className="absolute -top-[30px] left-0 font-mono text-[11px] text-[#a1a1aa]"
          >
            {title}
          </span>
          <ul
            className="m-0 grid list-none p-0"
            style={{
              gridTemplateColumns: `repeat(${String(members.length)}, ${String(CELL_W)}px)`,
              columnGap: GAP_X,
            }}
          >
            {members.map((member) => (
              <li key={member.agentId} className="m-0 p-0">
                {node(member)}
              </li>
            ))}
          </ul>
        </div>
      </li>,
    );
  }

  const center = (n: GraphNode) => ({ cx: x(n.column) + CELL_W / 2, cy: y(n.row) + CELL_H / 2 });

  return (
    <section
      aria-label="Graphe des agents"
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/6 p-8"
    >
      <div className="relative mx-auto" style={{ width, height }}>
        {edges.length > 0 && (
          <svg
            aria-hidden="true"
            focusable="false"
            width={width}
            height={height}
            className="pointer-events-none absolute inset-0"
          >
            {edges.map((edge) => {
              const from = at.get(edge.from);
              const to = at.get(edge.to);
              if (!from || !to) return null;
              const a = center(from);
              const b = center(to);
              const sameRow = from.row === to.row;
              const d = sameRow
                ? `M ${String(a.cx + CELL_W / 2)} ${String(a.cy)} L ${String(b.cx - CELL_W / 2)} ${String(b.cy)}`
                : `M ${String(a.cx)} ${String(a.cy + CELL_H / 2)} C ${String(a.cx)} ${String(
                    (a.cy + b.cy) / 2,
                  )}, ${String(b.cx)} ${String((a.cy + b.cy) / 2)}, ${String(b.cx)} ${String(
                    b.cy - CELL_H / 2,
                  )}`;
              const loop = edge.kind === 'loop';
              return (
                <path
                  key={`${edge.kind}:${edge.from}:${edge.to}`}
                  d={d}
                  fill="none"
                  stroke={loop ? 'var(--action)' : 'rgb(255 255 255 / 0.28)'}
                  strokeWidth={loop ? 2 : 1.5}
                  strokeDasharray={loop ? undefined : '4 4'}
                />
              );
            })}
          </svg>
        )}
        <ul
          aria-label="Agents"
          className="m-0 grid list-none p-0"
          style={{
            gridTemplateColumns: `repeat(${String(columns)}, ${String(CELL_W)}px)`,
            gridAutoRows: CELL_H,
            columnGap: GAP_X,
            rowGap: GAP_Y,
          }}
        >
          {items}
        </ul>
      </div>
    </section>
  );
}
