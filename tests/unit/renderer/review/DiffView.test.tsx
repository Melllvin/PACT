import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from '../../../../src/renderer/review/DiffView';
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
