import type { Agent, Loop } from '../../shared/model';

/** What a loop told the orchestrator (`orchestrator:report`). */
export type Report = {
  agentId: string;
  kind: 'report' | 'report-missing' | 'loop' | 'publish' | 'mockup';
  summary: string;
  at: string;
};

const KIND_LABELS: Record<Report['kind'], string> = {
  report: 'Rapport',
  'report-missing': 'Rapport manquant',
  loop: 'Boucle',
  publish: 'Publication',
  mockup: 'Maquette',
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

type Props = {
  reports: readonly Report[];
  /** Every agent of the workspace, in position order. */
  agents: readonly Agent[];
  loops: readonly Loop[];
  name: (cliId: string) => string;
};

/**
 * « ◎ Rapports » of the orchestrator's Focus (004 FR-006a): the latest report of each agent, with
 * its issue, its status and its round, read without opening the agent's terminal.
 */
export function ReportsTab({ reports, agents, loops, name }: Props) {
  const latest = new Map<string, Report>();
  // A kind that no longer exists (an old « Fichiers communs » report) is left out.
  for (const report of reports) if (report.kind in KIND_LABELS) latest.set(report.agentId, report);
  const rows = agents.flatMap((agent) => {
    const report = latest.get(agent.id);
    return report ? [{ agent, report }] : [];
  });
  if (rows.length === 0) {
    return (
      <p className="m-0 flex-1 px-4 py-3 text-[12.5px] text-dim">
        Aucun rapport reçu pour l’instant.
      </p>
    );
  }
  return (
    <ol aria-label="Rapports" className="m-0 flex-1 list-none overflow-auto p-0">
      {rows.map(({ agent, report }) => {
        // The loop it works in, the running one first, else its latest.
        const mine = loops.filter((l) => l.devAgentId === agent.id || l.testAgentId === agent.id);
        const loop = mine.find((l) => l.state === 'running') ?? mine.at(-1);
        return (
          <li
            key={agent.id}
            data-kind={report.kind}
            className="flex flex-col gap-1 border-b border-white/6 px-4 py-2.5"
          >
            <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-muted-foreground">
              <span className="font-semibold text-foreground">
                {name(agent.cliId)} {agent.position}
              </span>
              {loop && (
                <span>
                  {loop.issueId} · tour {loop.round}/3
                </span>
              )}
              <span>{KIND_LABELS[report.kind]}</span>
              <time dateTime={report.at} className="ml-auto font-mono text-[11px] text-dim">
                {TIME.format(new Date(report.at))}
              </time>
            </span>
            <p className="m-0 font-mono text-[12px] leading-normal whitespace-pre-wrap text-foreground">
              {report.summary}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
