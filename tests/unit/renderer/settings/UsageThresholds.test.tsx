import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UsageThresholds } from '../../../../src/renderer/settings/UsageThresholds';

// 005 T021 — the alert thresholds: integers, the first from 1 to 99, below the second (FR-010).

describe('UsageThresholds', () => {
  it('saves two thresholds, the first below the second', async () => {
    const onSave = vi.fn();
    render(<UsageThresholds thresholds={{ warn: 80, critical: 95 }} onSave={onSave} />);
    const second = screen.getByRole('spinbutton', { name: /Second seuil/ });
    await userEvent.clear(second);
    await userEvent.type(second, '90');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(onSave).toHaveBeenCalledWith({ warn: 80, critical: 90 });
  });

  it.each([
    ['95', '95'],
    ['0', '50'],
    ['50', '101'],
    ['50.5', '90'],
    ['', '90'],
  ])('refuses %s % then %s %', async (warn, critical) => {
    const onSave = vi.fn();
    render(<UsageThresholds thresholds={{ warn: 80, critical: 95 }} onSave={onSave} />);
    const first = screen.getByRole('spinbutton', { name: /Premier seuil/ });
    const second = screen.getByRole('spinbutton', { name: /Second seuil/ });
    await userEvent.clear(first);
    if (warn !== '') await userEvent.type(first, warn);
    await userEvent.clear(second);
    await userEvent.type(second, critical);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toHaveProperty('disabled', true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
