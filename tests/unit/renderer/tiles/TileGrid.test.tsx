import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileGrid } from '../../../../src/renderer/tiles/TileGrid';

// 006 Phase 4 — T019 (disposition `lead`, FR-010, FR-010b) and T051 (without an orchestrator,
// FR-010a, FR-010b, #40 #47). Replaces the 2×2 / 3×2 tests of 001 FR-019 and the lead on top of
// 004 FR-006a (two stacked sections), which the spec removes.
//
// What the tests read of the grid (the region « Tuiles »): its columns, from the inline
// `grid-template-columns: repeat(N, …)` or a `grid-cols-N` class; the height of its rows, from
// `grid-auto-rows` (inline or `auto-rows-[…]`), which R3 sets to half the visible height; its
// vertical scroll, from the `overflow-y-auto` class. The geometry itself is in the e2e `layout`.

const tiles = (count: number) =>
  Array.from({ length: count }, (_, i) => (
    <article key={i} aria-label={`Tuile ${String(i + 1)}`} />
  ));

const grid = () => screen.getByRole('region', { name: 'Tuiles' });
const plus = () => screen.queryAllByRole('button', { name: 'Ajouter un agent' });

/** The number of columns of the grid, however it is written. */
const columns = () => {
  const inline = /repeat\(\s*(\d+)\s*,/.exec(grid().style.gridTemplateColumns);
  const named = /(?:^|\s)grid-cols-(\d+)(?:\s|$)/.exec(grid().className);
  return Number((inline ?? named)?.[1]);
};

/** The height of a row, as written: `calc((100% - gap) / 2)` or half of the visible height. */
const rowHeight = () => {
  const inline = grid().style.gridAutoRows;
  const named = /auto-rows-\[([^\]]+)\]/.exec(grid().className)?.[1]?.replaceAll('_', ' ');
  return inline || named || '';
};
const HALF = /(\/\s*2\s*\)?$|^50%$|^calc\(\s*50%)/;

const children = () => Array.from(grid().children);
const labels = (elements: Element[]) => elements.map((e) => e.getAttribute('aria-label'));

describe('TileGrid with an orchestrator (T019, FR-010, FR-010b)', () => {
  const lead = (count: number, onAdd: (() => void) | null = vi.fn()) =>
    render(
      <TileGrid onAdd={onAdd ?? undefined} lead={<article aria-label="Chef" />}>
        {tiles(count)}
      </TileGrid>,
    );

  it.each([0, 1, 2, 3, 5])('is one grid of 3 columns with %i agents', (count) => {
    lead(count);
    expect(grid().dataset.layout).toBe('lead');
    expect(columns()).toBe(3);
    // One grid, not the two stacked sections of 004.
    expect(screen.queryByRole('region', { name: 'Agents dirigés' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Orchestrateur' })).toBeNull();
  });

  it.each([0, 1, 2, 3, 5])(
    'puts the orchestrator first, on 2 columns × 2 rows, then the %i agents in order',
    (count) => {
      lead(count);
      const [first, ...others] = children();
      expect(first?.className).toMatch(/(?:^|\s)col-span-2(?:\s|$)/);
      expect(first?.className).toMatch(/(?:^|\s)row-span-2(?:\s|$)/);
      expect(first?.contains(screen.getByRole('article', { name: 'Chef' }))).toBe(true);
      expect(screen.getAllByRole('article')[0]?.getAttribute('aria-label')).toBe('Chef');
      // The agents come after it, in order; the placement of the grid does the right column
      // (agents 1 and 2) and the rows of 3 below.
      const agents = others.filter((e) => e.getAttribute('aria-label')?.startsWith('Tuile'));
      expect(labels(agents)).toEqual(
        Array.from({ length: count }, (_, i) => `Tuile ${String(i + 1)}`),
      );
      // None of the agents is itself spanning several cells.
      for (const agent of agents) expect(agent.className).not.toMatch(/(?:col|row)-span-/);
    },
  );

  it('scrolls vertically, never horizontally, and the rows take half of the visible height', () => {
    lead(5);
    expect(grid().className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(grid().className).not.toMatch(/overflow-x-(?:auto|scroll)/);
    expect(grid().className).not.toMatch(/(?:^|\s)overflow-auto(?:\s|$)/);
    expect(rowHeight()).toMatch(HALF);
  });

  it.each([
    [0, 1],
    [1, 1],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 0],
  ])('with %i agents, shows %i « + » (one only, if the last row has a free place)', (n, shown) => {
    lead(n);
    expect(plus()).toHaveLength(shown);
    // No empty slot either: the cells are the orchestrator, the agents and that one « + ».
    expect(children()).toHaveLength(1 + n + shown);
  });

  it('opens the add menu from the « + »', async () => {
    const onAdd = vi.fn();
    lead(1, onAdd);
    await userEvent.click(plus()[0] ?? document.body);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('offers no « + » and no empty slot when no agent can be added', () => {
    lead(1, null);
    expect(plus()).toHaveLength(0);
    expect(children()).toHaveLength(2);
  });
});

describe('TileGrid without an orchestrator (T051, FR-010a, FR-010b)', () => {
  const plain = (count: number, onAdd: (() => void) | null = vi.fn()) =>
    render(<TileGrid onAdd={onAdd ?? undefined}>{tiles(count)}</TileGrid>);

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 2],
    [6, 3],
    [7, 3],
  ])('lays %i tiles out on %i columns', (count, cols) => {
    plain(count);
    expect(columns()).toBe(cols);
    expect(screen.queryByRole('region', { name: 'Orchestrateur' })).toBeNull();
  });

  it('keeps 3 columns for 5 tiles (3×2, FR-010a)', () => {
    plain(5);
    expect(columns()).toBe(3);
  });

  it.each([1, 2, 3, 4, 6, 7])(
    'with %i tiles, the rows take half of the visible height and the grid scrolls vertically',
    (count) => {
      plain(count);
      expect(rowHeight()).toMatch(HALF);
      expect(grid().className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
      expect(grid().className).not.toMatch(/overflow-x-(?:auto|scroll)/);
    },
  );

  it.each([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 1],
    [6, 0],
    [7, 1],
  ])('with %i tiles, shows %i « + » and no empty slot', (count, shown) => {
    plain(count);
    expect(plus()).toHaveLength(shown);
    expect(children()).toHaveLength(count + shown);
  });

  it('keeps every tile, the seventh on a row reached by scrolling', () => {
    plain(7);
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(columns()).toBe(3);
  });

  it('keeps the order it is given', () => {
    plain(3);
    expect(labels(screen.getAllByRole('article'))).toEqual(['Tuile 1', 'Tuile 2', 'Tuile 3']);
  });

  it('opens the add menu from the « + »', async () => {
    const onAdd = vi.fn();
    plain(5, onAdd);
    await userEvent.click(plus()[0] ?? document.body);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('offers no « + » and no empty slot when no agent can be added', () => {
    plain(5, null);
    expect(plus()).toHaveLength(0);
    expect(children()).toHaveLength(5);
  });
});
