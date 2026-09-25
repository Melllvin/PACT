import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LogPanel } from '../../../../src/renderer/tiles/LogPanel';

// T078 — « Journal »: the whole output kept for an agent, readable as text.

describe('LogPanel', () => {
  it('shows the output without terminal escape sequences', () => {
    render(
      <LogPanel
        name="Claude Code 1"
        text={'\u001b[1;31mErreur simulée\u001b[0m\r\n\u001b]0;titre\u0007> '}
        onClose={vi.fn()}
      />,
    );
    const panel = screen.getByRole('dialog', { name: 'Journal de Claude Code 1' });
    expect(panel.querySelector('pre')?.textContent).toBe('Erreur simulée\n> ');
  });

  it('says so when nothing was printed', () => {
    render(<LogPanel name="Claude Code 1" text="" onClose={vi.fn()} />);
    expect(screen.getByText('Aucune sortie pour l’instant.')).toBeDefined();
  });

  it('closes with « Fermer » or Escape', async () => {
    const onClose = vi.fn();
    render(<LogPanel name="Claude Code 1" text="x" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the focus inside the panel (modal dialog)', async () => {
    render(<LogPanel name="Claude Code 1" text="x" onClose={vi.fn()} />);
    const panel = screen.getByRole('dialog', { name: 'Journal de Claude Code 1' });
    for (let step = 0; step < 4; step++) {
      await userEvent.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });
});
