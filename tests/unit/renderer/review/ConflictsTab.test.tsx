import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConflictsTab } from '../../../../src/renderer/review/ConflictsTab';
import { IntegrationColumn } from '../../../../src/renderer/review/IntegrationColumn';
import type { Integration } from '../../../../src/shared/review';
import { agent } from '../tiles/fixtures';
import { conflicted, snapshot } from './fixtures';

// 002 T045 — screen 1q: the Conflits tab and the Intégration column (FR-027…FR-031).

const tab = (integration: Integration = conflicted()) => {
  const actions = { onResolve: vi.fn(), onEdit: vi.fn(), onOpenInEditor: vi.fn() };
  render(<ConflictsTab integration={integration} mainBranch="main" clean={10} {...actions} />);
  return { actions, user: userEvent.setup() };
};

describe('ConflictsTab', () => {
  it('lists the files in conflict and those without (FR-027)', () => {
    tab();
    expect(screen.getByRole('heading', { name: 'Conflits · 2' })).toBeDefined();
    const files = within(screen.getByRole('list', { name: 'Fichiers en conflit' }));
    expect(files.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '⚠ src/db.ts',
      '⚠ src/auth.ts',
    ]);
    expect(screen.getByText('✓ 10 sans conflit')).toBeDefined();
  });

  it('shows each hunk of the file chosen with both versions and the commit of main', () => {
    tab();
    const hunk = screen.getByRole('group', { name: 'src/db.ts · conflit 1 / 2 · ligne 42' });
    expect(within(hunk).getByText('main · « Ajout SSO » a41f2c0')).toBeDefined();
    expect(within(hunk).getByText('<Button sso>')).toBeDefined();
    expect(within(hunk).getByText('cette version')).toBeDefined();
    expect(within(hunk).getByText('<OtpForm code />')).toBeDefined();
    for (const name of ['Garder main', 'Garder cette version', 'Les deux', 'Modifier…']) {
      expect(within(hunk).getByRole('button', { name })).toBeDefined();
    }
    expect(
      screen.getByRole('group', { name: 'src/db.ts · conflit 2 / 2 · ligne 60' }),
    ).toBeDefined();
  });

  it('resolves a hunk with the choice made, shown pressed (FR-029)', async () => {
    const { actions, user } = tab(
      conflicted(
        {},
        {
          hunks: [
            { index: 0, line: 42, main: ['m'], agent: ['a'], resolution: 'agent' },
            { index: 1, line: 60, main: ['a'], agent: ['b'], resolution: null },
          ],
        },
      ),
    );
    const first = screen.getByRole('group', { name: /conflit 1 \/ 2/ });
    expect(
      within(first)
        .getByRole('button', { name: 'Garder cette version' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const second = screen.getByRole('group', { name: /conflit 2 \/ 2/ });
    await user.click(within(second).getByRole('button', { name: 'Les deux' }));
    expect(actions.onResolve).toHaveBeenCalledWith('src/db.ts', 1, 'both');
  });

  it('edits the whole file in a monospace field with « Modifier… »', async () => {
    const { actions, user } = tab();
    const hunk = screen.getByRole('group', { name: /conflit 1 \/ 2/ });
    await user.click(within(hunk).getByRole('button', { name: 'Modifier…' }));
    const field = screen.getByRole('textbox', { name: 'Contenu de src/db.ts' });
    expect((field as HTMLTextAreaElement).value).toContain('<<<<<<< main');
    await user.clear(field);
    await user.type(field, 'résolu');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(actions.onEdit).toHaveBeenCalledWith('src/db.ts', 'résolu');
  });

  it('opens the file chosen in the editor', async () => {
    const { actions, user } = tab();
    await user.click(screen.getByRole('button', { name: 'Ouvrir dans l’éditeur' }));
    expect(actions.onOpenInEditor).toHaveBeenCalledWith('src/db.ts');
  });

  it('offers only one side or the other for a file deleted on one side', async () => {
    const { actions, user } = tab();
    await user.click(screen.getByRole('button', { name: '⚠ src/auth.ts' }));
    const whole = screen.getByRole('group', { name: 'src/auth.ts · fichier entier' });
    expect(within(whole).getByText('supprimé dans main')).toBeDefined();
    expect(within(whole).queryByRole('button', { name: 'Les deux' })).toBeNull();
    await user.click(within(whole).getByRole('button', { name: 'Garder main' }));
    expect(actions.onResolve).toHaveBeenCalledWith('src/auth.ts', 0, 'main');
  });

  it('marks a resolved file ✓', () => {
    tab(conflicted({}, { resolved: true, edited: 'ok\n' }));
    const files = within(screen.getByRole('list', { name: 'Fichiers en conflit' }));
    expect(files.getAllByRole('listitem')[0]?.textContent).toBe('✓ src/db.ts');
    // The first file left to resolve is shown first.
    expect(screen.getByRole('group', { name: 'src/auth.ts · fichier entier' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '✓ src/db.ts' }));
    expect(screen.getByText('Modifié à la main')).toBeDefined();
  });
});

const column = (integration: Integration = conflicted(), busy = false) => {
  const actions = {
    onAskAgent: vi.fn(),
    onFinish: vi.fn(),
    onCancel: vi.fn(),
    onRunTests: vi.fn(),
    onCancelTests: vi.fn(),
    onSetTestCommand: vi.fn(),
  };
  render(
    <IntegrationColumn
      integration={integration}
      agent={agent(1)}
      agentName="Claude Code"
      snapshot={snapshot()}
      tests={null}
      mainBranch="main"
      busy={busy}
      error={null}
      {...actions}
    />,
  );
  return {
    actions,
    aside: screen.getByRole('complementary', { name: 'Intégration' }),
    user: userEvent.setup(),
  };
};

describe('IntegrationColumn', () => {
  it('says how many conflicts are left and the integration that waits', () => {
    const { aside } = column();
    expect(aside.textContent).toContain('2 conflits avec main');
    expect(aside.textContent).toContain('Squash en 1 commit en attente');
    expect(aside.textContent).toContain('Ou résoudre ici · 0 / 2 résolu');
  });

  it('recommends asking the agent (FR-028)', async () => {
    const { actions, aside, user } = column();
    const recommended = within(aside).getByRole('region', { name: 'Recommandé' });
    expect(recommended.textContent).toContain('Demander à Claude Code');
    await user.click(within(recommended).getByRole('button', { name: 'Demander' }));
    expect(actions.onAskAgent).toHaveBeenCalled();
  });

  it('waits for the agent once asked', () => {
    const { aside } = column(conflicted({ state: 'waiting-agent' }));
    expect(aside.textContent).toContain('En attente de Claude Code');
    expect(within(aside).getByRole('button', { name: 'Demander' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('keeps « Terminer l’intégration » disabled until every file is resolved (FR-030)', async () => {
    const first = column();
    expect(
      within(first.aside)
        .getByRole('button', { name: 'Terminer l’intégration' })
        .hasAttribute('disabled'),
    ).toBe(true);
    cleanup();
    const all = conflicted();
    const done = column({
      ...all,
      conflicts: all.conflicts.map((file) => ({ ...file, resolved: true })),
    });
    expect(done.aside.textContent).toContain('2 / 2 résolu');
    await done.user.click(
      within(done.aside).getByRole('button', { name: 'Terminer l’intégration' }),
    );
    expect(done.actions.onFinish).toHaveBeenCalled();
  });

  it('cancels without touching main (FR-031)', async () => {
    const { actions, aside, user } = column();
    expect(aside.textContent).toContain('main n’est pas modifié');
    await user.click(within(aside).getByRole('button', { name: 'Annuler l’intégration' }));
    expect(actions.onCancel).toHaveBeenCalled();
  });
});
