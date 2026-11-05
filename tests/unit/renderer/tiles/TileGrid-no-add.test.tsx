import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TileGrid } from '../../../../src/renderer/tiles/TileGrid';

// 006 T019 / T051: without `onAdd`, the grid offers neither « + » nor an empty slot. The cases of
// TileGrid.test.tsx pass `undefined` to a helper whose default value is a mock, so they never reach
// that branch; here the prop is really absent.

const tiles = (count: number) =>
  Array.from({ length: count }, (_, i) => (
    <article key={i} aria-label={`Tuile ${String(i + 1)}`} />
  ));

describe('TileGrid without onAdd', () => {
  it('shows no « + » and no empty slot with an orchestrator', () => {
    render(
      <TileGrid onAdd={undefined} lead={<article aria-label="Chef" />}>
        {tiles(1)}
      </TileGrid>,
    );
    const grid = screen.getByRole('region', { name: 'Tuiles' });
    expect(screen.queryAllByRole('button', { name: 'Ajouter un agent' })).toHaveLength(0);
    expect(grid.children).toHaveLength(2);
  });

  it('shows no « + » and no empty slot without an orchestrator', () => {
    render(<TileGrid onAdd={undefined}>{tiles(5)}</TileGrid>);
    const grid = screen.getByRole('region', { name: 'Tuiles' });
    expect(screen.queryAllByRole('button', { name: 'Ajouter un agent' })).toHaveLength(0);
    expect(grid.children).toHaveLength(5);
  });
});
