import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalView } from '../../../../src/renderer/tiles/TerminalView';

// T068 — the tile body: the terminal registered for `termId`, attached while the tile is shown.

describe('TerminalView', () => {
  it('attaches the terminal while shown and detaches it when removed', () => {
    const detach = vi.fn();
    const registry = { attach: vi.fn(() => detach) };
    const { container, unmount } = render(
      <TerminalView termId="t1" registry={registry} label="Terminal de Claude Code" />,
    );
    const element = container.querySelector('[aria-label="Terminal de Claude Code"]');
    // 006 T022b: the terminal opens in an inner div (see Tile.test), inside the labelled body.
    expect(registry.attach).toHaveBeenCalledWith('t1', expect.any(HTMLElement));
    const attached = (
      registry.attach.mock.calls as unknown as [string, HTMLElement][]
    )[0]?.[1] as HTMLElement;
    expect(element?.contains(attached)).toBe(true);
    unmount();
    expect(detach).toHaveBeenCalled();
  });
});
