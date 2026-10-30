import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DecisionColumn } from '../../../../src/renderer/review/DecisionColumn';
import type { Agent } from '../../../../src/shared/model';
import type { ReviewSnapshot, TestRun } from '../../../../src/shared/review';
import { agent } from '../tiles/fixtures';
import { blob, snapshot } from './fixtures';

// 002 T029 — the Décision column of screen 1h: tests, conflicts, files left to see, the state of
// the agent, then « Intégrer dans main » (FR-016…FR-019, FR-024, FR-025).

const reviewed = (overrides: Partial<Agent> = {}) =>
  agent(1, { state: 'done', initialPrompt: 'Ajoute les sessions\nen PostgreSQL', ...overrides });

const run = (overrides: Partial<TestRun> = {}): TestRun => ({
  agentId: reviewed().id,
  command: 'npm test',
  tree: blob(2),
  status: 'passed',
  passedCount: 24,
  outputTail: 'Tests  24 passed (24)\n',
  ...overrides,
});

const setup = (
  props: {
    agent?: Agent;
    snapshot?: ReviewSnapshot | null;
    tests?: TestRun | null;
    busy?: boolean;
    error?: { message: string; files: string[] } | null;
    sent?: boolean;
  } = {},
) => {
  const actions = {
    onRunTests: vi.fn(),
    onCancelTests: vi.fn(),
    onSetTestCommand: vi.fn(),
    onIntegrate: vi.fn(),
    onSendBack: vi.fn(),
    onAbandon: vi.fn(),
  };
  render(
    <DecisionColumn
      agent={props.agent ?? reviewed()}
      snapshot={
        props.snapshot === undefined ? snapshot({ testCommand: 'npm test' }) : props.snapshot
      }
      mainBranch="main"
      tests={props.tests ?? null}
      busy={props.busy ?? false}
      error={props.error ?? null}
      sent={props.sent ?? false}
      {...actions}
    />,
  );
  const column = screen.getByRole('complementary', { name: 'Décision' });
  return { actions, column, user: userEvent.setup() };
};

describe('DecisionColumn, what to know before integrating (FR-016)', () => {
  it('says the tests passed, with their count', () => {
    const { column } = setup({ tests: run() });
    expect(column.textContent).toContain('Tests : 24 réussis');
  });

  it('says the tests passed without a count when the output gives none', () => {
    const { column } = setup({ tests: run({ passedCount: null }) });
    expect(column.textContent).toContain('Tests réussis');
  });

  it('says the tests failed or took too long, with their output, and offers to run them again', async () => {
    const failed = setup({ tests: run({ status: 'failed', outputTail: '2 tests en échec\n' }) });
    expect(failed.column.textContent).toContain('Tests en échec');
    expect(within(failed.column).getByText('2 tests en échec')).toBeDefined();
    await failed.user.click(within(failed.column).getByRole('button', { name: 'Relancer' }));
    expect(failed.actions.onRunTests).toHaveBeenCalledOnce();
  });

  it('says the tests took too long, or were cancelled', () => {
    expect(setup({ tests: run({ status: 'timeout' }) }).column.textContent).toContain(
      'Tests : délai dépassé',
    );
    expect(screen.getAllByRole('complementary', { name: 'Décision' }).length).toBeGreaterThan(0);
  });

  it('says the tests were cancelled', () => {
    expect(setup({ tests: run({ status: 'cancelled' }) }).column.textContent).toContain(
      'Tests : annulés',
    );
  });

  it('says a result was for the changes before the last ones', () => {
    const { column } = setup({ tests: run({ tree: blob(9) }) });
    expect(column.textContent).toContain('avant les derniers changements');
  });

  it('shows the tests running, and cancels them', async () => {
    const { column, user, actions } = setup({ tests: run({ status: 'running' }) });
    expect(column.textContent).toContain('Tests : en cours');
    await user.click(within(column).getByRole('button', { name: 'Annuler les tests' }));
    expect(actions.onCancelTests).toHaveBeenCalledOnce();
  });

  it('offers to run tests not run yet', async () => {
    const { column, user, actions } = setup();
    expect(column.textContent).toContain('Tests : non lancés');
    await user.click(within(column).getByRole('button', { name: 'Lancer' }));
    expect(actions.onRunTests).toHaveBeenCalledOnce();
  });

  it('asks for the command of tests not set up, then saves it', async () => {
    const { column, user, actions } = setup({ snapshot: snapshot({ testCommand: null }) });
    expect(column.textContent).toContain('Tests : non configurés');
    const save = within(column).getByRole('button', { name: 'Enregistrer' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      within(column).getByRole('textbox', { name: 'Commande de test' }),
      ' make check ',
    );
    await user.click(save);
    expect(actions.onSetTestCommand).toHaveBeenCalledWith('make check');
  });

  it('offers no new run of tests no longer set up', () => {
    const { column } = setup({ snapshot: snapshot({ testCommand: null }), tests: run() });
    expect(within(column).queryByRole('button', { name: 'Relancer' })).toBeNull();
  });

  it('says whether the changes conflict with main', () => {
    expect(setup().column.textContent).toContain('Aucun conflit avec main');
  });

  it('counts the conflicting files', () => {
    const { column } = setup({ snapshot: snapshot({ conflicts: ['src/db.ts', 'src/auth.ts'] }) });
    expect(column.textContent).toContain('2 conflits avec main');
  });

  it('says one conflicting file, or a check in progress', () => {
    expect(
      setup({ snapshot: snapshot({ conflicts: ['src/db.ts'] }) }).column.textContent,
    ).toContain('1 conflit avec main');
  });

  it('says the conflicts are being checked', () => {
    expect(setup({ snapshot: snapshot({ conflicts: 'checking' }) }).column.textContent).toContain(
      'Conflits : vérification',
    );
  });

  it('counts the files left to see, and says when all are seen', () => {
    expect(setup().column.textContent).toContain('3 fichiers non vus');
  });

  it('says all the files are seen', () => {
    const seen = Object.fromEntries(snapshot().files.map((f) => [f.path, f.blob ?? blob(0)]));
    const { column } = setup({ agent: reviewed({ review: { seen, comments: [] } }) });
    expect(column.textContent).toContain('Tous les fichiers sont vus');
  });

  it('says one file left to see', () => {
    const files = snapshot().files.slice(0, 1);
    expect(setup({ snapshot: snapshot({ files }) }).column.textContent).toContain(
      '1 fichier non vu',
    );
  });

  it('gives the state of the agent', () => {
    expect(setup({ agent: reviewed({ state: 'working' }) }).column.textContent).toContain(
      'Agent : travaille encore',
    );
  });

  it('shows nothing to integrate while loading, for a missing worktree or without changes', () => {
    setup({ snapshot: null, agent: reviewed({ state: 'starting' }) });
    expect(screen.queryByRole('button', { name: '✓ Intégrer' })).toBeNull();
  });

  it('shows nothing to integrate for a missing worktree', () => {
    setup({ snapshot: snapshot({ missing: true }) });
    expect(screen.queryByRole('button', { name: '✓ Intégrer' })).toBeNull();
  });

  it('shows nothing to integrate without changes', () => {
    setup({ snapshot: snapshot({ files: [] }) });
    expect(screen.queryByRole('button', { name: '✓ Intégrer' })).toBeNull();
  });
});

describe('DecisionColumn, integrating (FR-019, FR-024, FR-025)', () => {
  const after = { closeTile: true, removeWorktree: true };

  it('integrates in one squashed commit by default, with the prompt of the agent as message', async () => {
    const { column, user, actions } = setup();
    expect(column.textContent).toContain('Intégrer dans main');
    expect(within(column).getByRole('textbox', { name: 'Message du commit' })).toHaveProperty(
      'value',
      'Ajoute les sessions',
    );
    expect(
      within(column)
        .getByRole('checkbox', { name: /Fermer la tuile/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    expect(actions.onIntegrate).toHaveBeenCalledWith({
      mode: 'squash',
      message: 'Ajoute les sessions',
      after,
    });
  });

  it('proposes the branch as message for an agent without a prompt', () => {
    const { column } = setup({ agent: reviewed({ initialPrompt: null }) });
    expect(within(column).getByRole('textbox', { name: 'Message du commit' })).toHaveProperty(
      'value',
      'Intègre agent/pg-sessions',
    );
  });

  it('keeps the commits of the agent when chosen in the menu, with the message written', async () => {
    const { column, user, actions } = setup();
    const trigger = within(column).getByRole('button', { name: 'Squash en 1 commit ▾' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitemradio', { name: 'Garder les commits' }));
    const message = within(column).getByRole('textbox', { name: 'Message du commit' });
    await user.clear(message);
    await user.type(message, 'Sessions PostgreSQL');
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    expect(actions.onIntegrate).toHaveBeenCalledWith({
      mode: 'keep-commits',
      message: 'Sessions PostgreSQL',
      after,
    });
    expect(within(column).getByRole('button', { name: 'Garder les commits ▾' })).toBeDefined();
  });

  it('refuses an empty message', async () => {
    const { column, user } = setup();
    await user.clear(within(column).getByRole('textbox', { name: 'Message du commit' }));
    expect(within(column).getByRole('button', { name: '✓ Intégrer' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps the worktree when its box is unticked, and the tile when that one is', async () => {
    const { column, user, actions } = setup();
    const remove = within(column).getByRole('checkbox', { name: 'Supprimer worktree et branche' });
    await user.click(remove);
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    expect(actions.onIntegrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { closeTile: true, removeWorktree: false } }),
    );
    await user.click(remove);
    await user.click(within(column).getByRole('checkbox', { name: /Fermer la tuile/ }));
    // The worktree of an agent left open cannot go.
    expect(remove).toHaveProperty('disabled', true);
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    expect(actions.onIntegrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { closeTile: false, removeWorktree: false } }),
    );
  });

  it('integrates and keeps the agent with « Conserver le worktree » (US2/AC4)', async () => {
    const { column, user, actions } = setup();
    await user.click(within(column).getByRole('button', { name: 'Conserver le worktree' }));
    expect(actions.onIntegrate).toHaveBeenCalledWith(
      expect.objectContaining({ after: { closeTile: false, removeWorktree: false } }),
    );
  });

  it('asks before integrating an agent still working (FR-025)', async () => {
    const { column, user, actions } = setup({ agent: reviewed({ state: 'awaiting-answer' }) });
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    expect(actions.onIntegrate).not.toHaveBeenCalled();
    const question = within(column).getByRole('alertdialog', { name: /travaille encore/ });
    await user.click(within(question).getByRole('button', { name: 'Annuler' }));
    expect(within(column).queryByRole('alertdialog')).toBeNull();
    await user.click(within(column).getByRole('button', { name: '✓ Intégrer' }));
    await user.click(within(column).getByRole('button', { name: 'Intégrer quand même' }));
    expect(actions.onIntegrate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'squash', confirmWorking: true }),
    );
  });

  it('waits for the integration in progress', () => {
    const { column } = setup({ busy: true });
    expect(within(column).getByRole('button', { name: 'Intégration…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(column).getByRole('button', { name: 'Conserver le worktree' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('lists the local changes that block the integration (FR-021)', () => {
    const { column } = setup({
      error: {
        message: 'Des changements locaux sur la branche principale bloquent l’intégration.',
        files: ['src/db.ts', 'notes 1.md'],
      },
    });
    const alert = within(column).getByRole('alert');
    expect(alert.textContent).toContain('bloquent l’intégration');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['src/db.ts', 'notes 1.md']);
  });

  it('shows the error of git as it came (FR-023)', () => {
    const { column } = setup({
      error: { message: 'pre-commit: lint en échec', files: [] },
    });
    const alert = within(column).getByRole('alert');
    expect(alert.textContent).toBe('pre-commit: lint en échec');
    expect(within(alert).queryByRole('list')).toBeNull();
  });
});

describe('DecisionColumn, « Renvoyer à l’agent » (002 T038, FR-015)', () => {
  it('sends the request written, once there is one', async () => {
    const { actions, column, user } = setup();
    const send = within(column).getByRole('button', { name: 'Renvoyer à l’agent' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.type(
      within(column).getByRole('textbox', { name: 'Demande à l’agent' }),
      'Ajoute un test pour le cas vide.',
    );
    await user.click(send);
    expect(actions.onSendBack).toHaveBeenCalledWith('Ajoute un test pour le cas vide.');
  });

  it('follows the correction the review asked for (US3 scenario 6)', () => {
    expect(
      setup({ agent: reviewed({ state: 'working' }), sent: true }).column.textContent,
    ).toContain('Agent : correction en cours');
  });

  it('sends nothing back for a missing worktree', () => {
    setup({ snapshot: snapshot({ missing: true }) });
    expect(screen.queryByRole('button', { name: 'Renvoyer à l’agent' })).toBeNull();
  });
});

describe('DecisionColumn, « ✕ Abandonner » (002 T052, FR-032)', () => {
  it('asks first, then hands over to the closing of the agent; nothing is integrated', async () => {
    const { actions, column, user } = setup();
    await user.click(within(column).getByRole('button', { name: '✕ Abandonner' }));
    const question = within(column).getByRole('alertdialog', { name: 'Abandonner ce travail ?' });
    expect(actions.onAbandon).not.toHaveBeenCalled();
    await user.click(within(question).getByRole('button', { name: 'Annuler' }));
    expect(within(column).queryByRole('alertdialog')).toBeNull();
    await user.click(within(column).getByRole('button', { name: '✕ Abandonner' }));
    await user.click(
      within(within(column).getByRole('alertdialog')).getByRole('button', { name: 'Abandonner' }),
    );
    expect(actions.onAbandon).toHaveBeenCalled();
    expect(actions.onIntegrate).not.toHaveBeenCalled();
  });

  it('is all that is left when the worktree is gone', () => {
    const { column } = setup({ snapshot: snapshot({ missing: true, files: [] }) });
    expect(within(column).getByRole('button', { name: '✕ Abandonner' })).toBeDefined();
    expect(within(column).queryByRole('button', { name: '✓ Intégrer' })).toBeNull();
    expect(column.textContent).toContain('Worktree introuvable');
  });
});
