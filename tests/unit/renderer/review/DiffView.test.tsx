import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../../../src/renderer/review/DiffView';
import type { ReviewComment } from '../../../../src/shared/model';
import type { DiffLine } from '../../../../src/shared/review';
import { diff, file } from './fixtures';

// 002 T017 — the diff of one file against main (FR-008), virtualised for long files (R10).

const rows = () => screen.getAllByRole('row');
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('DiffView', () => {
  it('shows added, removed and unchanged lines with the numbers of both sides', () => {
    render(<DiffView file={file('src/db.ts')} diff={diff()} viewportHeight={400} />);
    expect(screen.getByRole('table', { name: 'Diff de src/db.ts' })).toBeDefined();
    const [hunk, context, del, add] = rows();
    expect(hunk?.textContent).toContain('@@ -1,2 +1,2 @@');
    expect(context?.getAttribute('data-kind')).toBe('context');
    expect(cells(context ?? document.body)).toEqual([
      '1',
      '1',
      ' ',
      'import { pool } from "./pool";',
    ]);
    expect(del?.getAttribute('data-kind')).toBe('del');
    expect(cells(del ?? document.body)).toEqual(['2', '', '−', 'const timeout = 10;']);
    expect(add?.getAttribute('data-kind')).toBe('add');
    expect(cells(add ?? document.body)).toEqual(['', '2', '+', 'const timeout = 30;']);
  });

  it('shows a binary file by its kind and size, without lines', () => {
    render(
      <DiffView
        file={file('logo.png', { binary: true, added: null, removed: null, status: 'added' })}
        diff={diff('logo.png', { hunks: [], size: 2048 })}
        viewportHeight={400}
      />,
    );
    expect(screen.getByText('Fichier binaire ajouté · 2,0 Ko')).toBeDefined();
    expect(screen.queryAllByRole('row')).toEqual([]);
  });

  it('shows a too large file by its kind and size, without lines', () => {
    render(
      <DiffView
        file={file('dump.sql', { tooLarge: true })}
        diff={diff('dump.sql', { hunks: [], size: 3 * 1024 * 1024 })}
        viewportHeight={400}
      />,
    );
    expect(
      screen.getByText('Fichier trop gros pour un diff ligne à ligne, modifié · 3,0 Mo'),
    ).toBeDefined();
  });

  it('says when a file only changed its line endings', () => {
    render(
      <DiffView
        file={file('crlf.txt', { eolOnly: true })}
        diff={diff('crlf.txt', { hunks: [] })}
        viewportHeight={400}
      />,
    );
    expect(screen.getByText('Fins de ligne seulement')).toBeDefined();
  });

  it('waits for the diff before showing anything', () => {
    render(<DiffView file={file('src/db.ts')} diff={null} viewportHeight={400} />);
    expect(screen.getByText('Chargement du diff…')).toBeDefined();
  });

  it('renders only the visible lines of a 5 000 line diff, and follows the scroll', () => {
    const lines: DiffLine[] = Array.from({ length: 5000 }, (_, i) => ({
      kind: 'add',
      oldNo: null,
      newNo: i + 1,
      text: `ligne ${String(i + 1)}`,
    }));
    render(
      <DiffView
        file={file('big.ts', { added: 5000, removed: 0, status: 'added' })}
        diff={diff('big.ts', { hunks: [{ oldStart: 0, newStart: 1, lines }] })}
        viewportHeight={400}
      />,
    );
    expect(rows().length).toBeLessThan(60);
    expect(screen.getByText('ligne 1')).toBeDefined();
    expect(screen.queryByText('ligne 4000')).toBeNull();
    const table = screen.getByRole('table', { name: 'Diff de big.ts' });
    table.scrollTop = 4000 * 20;
    fireEvent.scroll(table);
    expect(screen.getByText('ligne 4000')).toBeDefined();
    expect(screen.queryByText('ligne 1')).toBeNull();
    expect(rows().length).toBeLessThan(60);
  });
});

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  path: 'src/db.ts',
  line: 2,
  text: 'Le délai devrait venir de la config.',
  createdAt: '2026-10-30T10:00:00.000Z',
  treated: false,
  ...overrides,
});

describe('DiffView comments (002 T038, FR-012)', () => {
  it('opens a comment field on a line; Enter sends it with the line on the agent side', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn();
    render(
      <DiffView
        file={file('src/db.ts')}
        diff={diff()}
        viewportHeight={400}
        comments={[]}
        onComment={onComment}
      />,
    );
    // A removed line has no line on the agent's side: nothing to comment there.
    expect(screen.queryByRole('button', { name: /Commenter.*ligne 2 retirée/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Commenter la ligne 2' }));
    const field = screen.getByRole('textbox', { name: 'Commentaire sur la ligne 2' });
    await user.type(field, 'Pourquoi 30 ?{Enter}');
    expect(onComment).toHaveBeenCalledWith(2, 'Pourquoi 30 ?');
    expect(screen.queryByRole('textbox', { name: 'Commentaire sur la ligne 2' })).toBeNull();
  });

  it('cancels the comment with Escape, without sending anything', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn();
    const onKeyDown = vi.fn();
    document.addEventListener('keydown', onKeyDown);
    render(
      <DiffView
        file={file('src/db.ts')}
        diff={diff()}
        viewportHeight={400}
        comments={[]}
        onComment={onComment}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Commenter la ligne 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Commentaire sur la ligne 1' }), 'abc');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onComment).not.toHaveBeenCalled();
    // Escape stays with the field: the Focus does not go back to the tiles.
    expect(onKeyDown).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onKeyDown);
  });

  it('does not send an empty comment', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn();
    render(
      <DiffView
        file={file('src/db.ts')}
        diff={diff()}
        viewportHeight={400}
        comments={[]}
        onComment={onComment}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Commenter la ligne 2' }));
    await user.type(screen.getByRole('textbox'), '   {Enter}');
    expect(onComment).not.toHaveBeenCalled();
  });

  it('shows each comment under its line, sent to the agent', () => {
    render(
      <DiffView
        file={file('src/db.ts')}
        diff={diff()}
        viewportHeight={400}
        comments={[comment()]}
        onComment={vi.fn()}
      />,
    );
    const shown = screen.getByRole('note', { name: 'Commentaire sur la ligne 2' });
    expect(shown.textContent).toContain('Le délai devrait venir de la config.');
    expect(shown.textContent).toContain('→ envoyé à l’agent ↓');
    const all = rows();
    const addRow = all.findIndex((row) => row.getAttribute('data-kind') === 'add');
    expect(all[addRow + 1]?.contains(shown)).toBe(true);
  });

  it('offers no comment without a handler', () => {
    render(<DiffView file={file('src/db.ts')} diff={diff()} viewportHeight={400} />);
    expect(screen.queryByRole('button', { name: /Commenter/ })).toBeNull();
  });
});
