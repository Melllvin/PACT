import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileList } from '../../../../src/renderer/review/FileList';
import { file, snapshot } from './fixtures';

// 002 T017 — the changed files of an agent, each with its kind, its lines and « vu » (FR-007).

const setup = (seen: Record<string, string> = {}, selected: string | null = 'src/db.ts') => {
  const props = { onSelect: vi.fn(), onSeen: vi.fn() };
  const files = [
    ...snapshot().files,
    file('src/new name.ts', { status: 'renamed', oldPath: 'src/old name.ts', added: 1 }),
    file('logo.png', { binary: true, added: null, removed: null, status: 'added' }),
  ];
  render(<FileList files={files} seen={seen} selected={selected} {...props} />);
  const list = screen.getByRole('list', { name: 'Fichiers' });
  const item = (path: string) =>
    within(list)
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('data-path') === path) ?? document.body;
  return { props, files, list, item };
};

const authBlob = snapshot().files[0]?.blob ?? '';

describe('FileList', () => {
  it('lists each file once with its kind and its lines', () => {
    const { list, item } = setup();
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(item('src/auth.ts').textContent).toContain('ajouté');
    expect(item('src/auth.ts').textContent).toContain('+84');
    expect(item('src/db.ts').textContent).toContain('modifié');
    expect(item('src/db.ts').textContent).toContain('+12');
    expect(item('src/db.ts').textContent).toContain('−6');
    expect(item('src/old.ts').textContent).toContain('supprimé');
    expect(item('src/new name.ts').textContent).toContain('renommé');
    expect(item('src/new name.ts').textContent).toContain('src/old name.ts');
    expect(item('logo.png').textContent).toContain('binaire');
  });

  it('marks the file shown and selects another one', async () => {
    const user = userEvent.setup();
    const { props, item } = setup();
    const shown = within(item('src/db.ts')).getByRole('button', { name: /src\/db\.ts/ });
    expect(shown.getAttribute('aria-current')).toBe('true');
    await user.click(within(item('src/auth.ts')).getByRole('button', { name: /src\/auth\.ts/ }));
    expect(props.onSelect).toHaveBeenCalledWith('src/auth.ts');
  });

  it('checks « vu » for a file whose content is the one seen, not for a changed one', () => {
    const { item } = setup({
      'src/auth.ts': authBlob,
      'src/db.ts': 'f'.repeat(40),
    });
    const box = (path: string) =>
      within(item(path)).getByRole('checkbox', { name: `Vu : ${path}` });
    expect(box('src/auth.ts').getAttribute('aria-checked')).toBe('true');
    expect(box('src/db.ts').getAttribute('aria-checked')).toBe('false');
  });

  it('marks a file seen, or not seen any more', async () => {
    const user = userEvent.setup();
    const { props, files, item } = setup({ 'src/auth.ts': authBlob });
    await user.click(within(item('src/db.ts')).getByRole('checkbox', { name: 'Vu : src/db.ts' }));
    await user.click(
      within(item('src/auth.ts')).getByRole('checkbox', { name: 'Vu : src/auth.ts' }),
    );
    expect(props.onSeen.mock.calls).toEqual([
      [files[1], true],
      [files[0], false],
    ]);
  });
});
