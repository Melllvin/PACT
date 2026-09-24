import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileGrid } from '../../../../src/renderer/tiles/TileGrid';

// T069 — 2×2 up to 4 tiles, 3×2 for 5 or 6, « + » in the free slots (FR-019, US3 scenario 1).

const tiles = (count: number) =>
  Array.from({ length: count }, (_, i) => (
    <article key={i} aria-label={`Tuile ${String(i + 1)}`} />
  ));

const grid = () => screen.getByRole('region', { name: 'Tuiles' });
const plus = () => screen.queryAllByRole('button', { name: 'Ajouter un agent' });

describe('TileGrid', () => {
  it.each([1, 2, 3, 4])('lays %i tiles out in 2×2, with « + » in the free slots', (count) => {
    render(<TileGrid onAdd={vi.fn()}>{tiles(count)}</TileGrid>);
    expect(grid().dataset.layout).toBe('2x2');
    expect(plus()).toHaveLength(4 - count);
  });

  it.each([5, 6])('lays %i tiles out in 3×2', (count) => {
    render(<TileGrid onAdd={vi.fn()}>{tiles(count)}</TileGrid>);
    expect(grid().dataset.layout).toBe('3x2');
    expect(plus()).toHaveLength(6 - count);
  });

  it('keeps the order it is given', () => {
    render(<TileGrid onAdd={vi.fn()}>{tiles(3)}</TileGrid>);
    expect(screen.getAllByRole('article').map((t) => t.getAttribute('aria-label'))).toEqual([
      'Tuile 1',
      'Tuile 2',
      'Tuile 3',
    ]);
  });

  it('opens the add menu from a « + »', async () => {
    const onAdd = vi.fn();
    render(<TileGrid onAdd={onAdd}>{tiles(1)}</TileGrid>);
    await userEvent.click(plus()[0] ?? document.body);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('offers no « + » when no agent can be added', () => {
    render(<TileGrid onAdd={undefined}>{tiles(2)}</TileGrid>);
    expect(plus()).toHaveLength(0);
    expect(grid().dataset.layout).toBe('2x2');
  });

  it('grows beyond 3×2 rather than hiding a tile', () => {
    render(<TileGrid onAdd={vi.fn()}>{tiles(7)}</TileGrid>);
    expect(grid().dataset.layout).toBe('3x2');
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(plus()).toHaveLength(0);
  });
});
