import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportsTab, type Report } from '../../../../src/renderer/focus/ReportsTab';
import { agent } from '../tiles/fixtures';

// 004 T027 — « ◎ Rapports »: the latest report of each agent, its issue, status and round.

const names = (id: string) => ({ 'claude-code': 'Claude Code' })[id] ?? id;
const loop = (issueId: string, state: 'running' | 'passed', round: number) => ({
  issueId,
  devAgentId: agent(2).id,
  testAgentId: agent(3).id,
  round,
  rounds: [],
  state,
  escalatedModel: null,
});
const at = '2026-11-03T10:00:00.000Z';

describe('ReportsTab', () => {
  it('names each kind, in the order of the agents, with the loop each one is in', () => {
    const reports: Report[] = [
      { agentId: agent(3).id, kind: 'report-missing', summary: 'Rien rendu', at },
      { agentId: agent(2).id, kind: 'report', summary: 'Rapport rendu', at },
      { agentId: agent(4).id, kind: 'loop', summary: 'Boucle finie', at },
      // An agent gone meanwhile is left out.
      { agentId: agent(9).id, kind: 'report', summary: 'Parti', at },
    ];
    render(
      <ReportsTab
        reports={reports}
        agents={[agent(1), agent(2), agent(3), agent(4)]}
        loops={[loop('0011-panier', 'passed', 3), loop('0012-connexion', 'passed', 1)]}
        name={names}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Rapports' })).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual([
      'report',
      'report-missing',
      'loop',
    ]);
    // With no running loop, its latest one.
    expect(items[0]?.textContent).toContain('0012-connexion · tour 1/3');
    expect(items[0]?.textContent).toContain('Rapport');
    expect(items[1]?.textContent).toContain('Rapport manquant');
    expect(items[2]?.textContent).toContain('Boucle');
    expect(items[2]?.textContent).not.toContain('tour');
  });

  // fix-relance-communs — « Fichiers communs » is no kind of report any more (Given two agents
  // that change the same file, the tab shows no such report).
  it('has no « Fichiers communs » report', () => {
    const reports = [
      { agentId: agent(2).id, kind: 'overlap', summary: 'fichiers communs : a.ts', at },
    ] as unknown as Report[];
    render(<ReportsTab reports={reports} agents={[agent(1), agent(2)]} loops={[]} name={names} />);
    expect(screen.queryByText('Fichiers communs')).toBeNull();
    expect(document.body.textContent).not.toContain('Fichiers communs');
  });
});
