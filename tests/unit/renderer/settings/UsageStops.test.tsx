import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UsageThresholds } from '../../../../src/renderer/settings/UsageThresholds';
import type { UsageStops } from '../../../../src/shared/usage-limit';

// 009 US4 — the edges of the section « Arrêt » that UsageThresholds.test.tsx does not reach.

const open = (stops: UsageStops = {}) => {
  const onSave = vi.fn<(stops: UsageStops) => void>();
  render(
    <UsageThresholds
      thresholds={{ warn: 80, critical: 95 }}
      onSave={vi.fn()}
      stopSettings={{
        stops,
        clis: [{ cliId: 'codex', name: 'Codex', windows: [{ id: 'week-opus' }] }],
        onSave,
      }}
    />,
  );
  return { onSave, section: screen.getByRole('group', { name: 'Arrêt' }) };
};

describe('UsageThresholds: the section « Arrêt » edges (009 US4)', () => {
  it('Given a window with no label, When the section shows, Then its id names the field', () => {
    const { section } = open();
    expect(within(section).getByRole('spinbutton', { name: /^week-opus : arrêt à/ })).toBeTruthy();
  });

  it('Given an invalid value, When the form is submitted anyway (Enter), Then nothing is saved', async () => {
    const { onSave, section } = open();
    const input = within(section).getByRole('spinbutton');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    const form = section.closest('form');
    if (!form) throw new Error('no form');
    fireEvent.submit(form);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Given thresholds saved for other windows of the CLI, When the user saves, Then they are kept', async () => {
    const { onSave, section } = open({ codex: { week: 70 }, 'claude-code': { week: 60 } });
    await userEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(onSave).toHaveBeenCalledWith({
      codex: { week: 70, 'week-opus': 90 },
      'claude-code': { week: 60 },
    });
  });
});
