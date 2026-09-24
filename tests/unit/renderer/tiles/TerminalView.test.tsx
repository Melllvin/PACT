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
    expect(registry.attach).toHaveBeenCalledWith('t1', element);
    unmount();
    expect(detach).toHaveBeenCalled();
  });
});
