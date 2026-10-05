import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangesTab } from '../../../../src/renderer/review/ChangesTab';
import type { ReviewSnapshot } from '../../../../src/shared/review';
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
