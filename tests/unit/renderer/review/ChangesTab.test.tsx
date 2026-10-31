import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangesTab } from '../../../../src/renderer/review/ChangesTab';
import type { ReviewComment } from '../../../../src/shared/model';
import type { ReviewSnapshot, TestRun } from '../../../../src/shared/review';
import { diff, snapshot } from './fixtures';

// 002 T017 — the Changements tab of the Focus (screen 1h, FR-006, FR-009).

const setup = (
  shown: ReviewSnapshot | null = snapshot(),
  seen: Record<string, string> = {},
  selected: string | null = 'src/db.ts',
) => {
  const props = { onSelect: vi.fn(), onSeen: vi.fn() };
  render(
    <ChangesTab
      snapshot={shown}
      seen={seen}
      selected={selected}
      diff={selected ? diff(selected) : null}
      error={null}
      {...props}
    />,
  );
  return { props };
};

const header = () => screen.getByRole('group', { name: 'Résumé des changements' });

describe('ChangesTab', () => {
  it('heads the review with the file count, the branch, the totals and the seen count', () => {
    const files = snapshot().files;
    setup(snapshot(), { 'src/auth.ts': files[0]?.blob ?? '' });
    expect(within(header()).getByRole('heading').textContent).toBe('Changements · 3');
    expect(header().textContent).toContain('⎇ agent/pg-sessions');
    expect(header().textContent).toContain('+96 −36 · 1 / 3 vus');
  });

  it('shows the list of files next to the diff of the one selected', () => {
    setup();
    expect(
      within(screen.getByRole('list', { name: 'Fichiers' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    expect(screen.getByRole('table', { name: 'Diff de src/db.ts' })).toBeDefined();
  });

  it('announces the changes made to seen files, and goes back to the first one (FR-009)', async () => {
    const user = userEvent.setup();
    const { props } = setup(snapshot({ newSinceSeen: { added: 3, removed: 1 } }), {
      'src/auth.ts': snapshot().files[0]?.blob ?? '',
      'src/db.ts': 'f'.repeat(40),
    });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Nouveaux changements : +3 −1 · revoir');
    await user.click(within(banner).getByRole('button', { name: 'revoir' }));
    expect(props.onSelect).toHaveBeenCalledWith('src/db.ts');
  });

  it('says there is nothing to review for an agent without changes (US1 scenario 5)', () => {
    setup(snapshot({ files: [], added: 0, removed: 0 }), {}, null);
    expect(screen.getByText('Rien à relire · cet agent n’a rien changé')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Fichiers' })).toBeNull();
  });

  it('says when the worktree of the agent is gone', () => {
    setup(snapshot({ files: [], missing: true }), {}, null);
    expect(screen.getByText('Le worktree de cet agent est introuvable.')).toBeDefined();
  });

  it('waits for the first snapshot', () => {
    setup(null, {}, null);
    expect(screen.getByText('Chargement des changements…')).toBeDefined();
  });

  it('shows why the review could not be read', () => {
    render(
      <ChangesTab
        snapshot={null}
        seen={{}}
        selected={null}
        diff={null}
        error="git a échoué"
        onSelect={vi.fn()}
        onSeen={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('git a échoué');
  });
});

const note = (n: number, overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  path: 'src/db.ts',
  line: n,
  text: `Commentaire ${String(n)}`,
  createdAt: '2026-10-30T10:00:00.000Z',
  treated: false,
  ...overrides,
});

const failing: TestRun = {
  agentId: snapshot().agentId,
  command: 'npm test',
  tree: snapshot().tree,
  status: 'failed',
  passedCount: null,
  outputTail: 'FAIL\n',
};

const withShortcuts = (
  props: { shown?: ReviewSnapshot; comments?: ReviewComment[]; tests?: TestRun | null } = {},
) => {
  const actions = { onSelect: vi.fn(), onSeen: vi.fn(), onComment: vi.fn(), onSend: vi.fn() };
  render(
    <ChangesTab
      snapshot={props.shown ?? snapshot()}
      seen={{}}
      selected="src/db.ts"
      diff={diff('src/db.ts')}
      error={null}
      comments={props.comments ?? []}
      tests={props.tests ?? null}
      {...actions}
    />,
  );
  return { actions, user: userEvent.setup() };
};

const bar = () => screen.queryByRole('toolbar', { name: 'Consignes pour l’agent' });

describe('ChangesTab shortcuts above the terminal (002 T038, FR-013)', () => {
  it('shows none when nothing applies', () => {
    withShortcuts();
    expect(bar()).toBeNull();
  });

  it('counts the untreated comments, and sends them in one prompt', async () => {
    const { actions, user } = withShortcuts({
      comments: [note(1), note(2), note(3, { treated: true })],
    });
    const button = within(bar() ?? document.body).getByRole('button', {
      name: 'Corriger les commentaires · 2',
    });
    await user.click(button);
    expect(actions.onSend).toHaveBeenCalledWith('fix-comments');
  });

  it('offers « Tests en échec » only when the tests fail', async () => {
    const { actions, user } = withShortcuts({ tests: failing });
    await user.click(
      within(bar() ?? document.body).getByRole('button', { name: 'Tests en échec' }),
    );
    expect(actions.onSend).toHaveBeenCalledWith('failing-tests');
    expect(screen.queryByRole('button', { name: /Corriger les commentaires/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conflit avec main' })).toBeNull();
  });

  it('offers « Conflit avec main » only with a conflict', async () => {
    const { actions, user } = withShortcuts({ shown: snapshot({ conflicts: ['src/db.ts'] }) });
    await user.click(
      within(bar() ?? document.body).getByRole('button', { name: 'Conflit avec main' }),
    );
    expect(actions.onSend).toHaveBeenCalledWith('conflict');
  });

  it('passes the comments of the file shown to its diff, and a new one with its path', async () => {
    const { actions, user } = withShortcuts({
      comments: [note(2), note(1, { path: 'src/auth.ts' })],
    });
    expect(screen.getAllByRole('note')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Commenter la ligne 1' }));
    await user.type(screen.getByRole('textbox'), 'Voir ici{Enter}');
    expect(actions.onComment).toHaveBeenCalledWith('src/db.ts', 1, 'Voir ici');
  });
});
