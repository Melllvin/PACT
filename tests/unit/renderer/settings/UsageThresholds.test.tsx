import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UsageThresholds } from '../../../../src/renderer/settings/UsageThresholds';
import { stopOf, type UsageStops } from '../../../../src/shared/usage-limit';

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

// 009 T043 — US4: the section « Arrêt » of the settings (contracts/ui.md « Réglages »; spec US4 sc.1, FR-001, O3).
//
// API fixed here for the dev (see the report, « API fixées »): `UsageThresholds` gets ONE optional prop,
//   stopSettings?: {
//     stops: UsageStops;                                              the saved thresholds (`usageStops`)
//     clis: { cliId: string; name: string; windows: { id: string; label?: string }[] }[]
//                                                                      one row per CLI, its windows from `windowsOf`
//     onSave(stops: UsageStops): void;                                the whole record, once « Enregistrer » is clicked
//   }
// Without it the component is the one of 005 (no section): the tests above are untouched. The section is
// `role="group"` named « Arrêt », with its own « Enregistrer » button; each CLI is a `role="group"` named by
// `name`; each window is a number field labelled « <fenêtre> : arrêt à » (label of the window, else its id).
// The note about the critical threshold reads the `thresholds` prop (95 by default).

describe('UsageThresholds: the section « Arrêt » (009 US4)', () => {
  const CLAUDE = {
    cliId: 'claude-code',
    name: 'Claude Code',
    windows: [
      { id: 'five-hour', label: '5 h' },
      { id: 'week', label: 'semaine' },
    ],
  };
  const CODEX = {
    cliId: 'codex',
    name: 'Codex',
    windows: [
      { id: 'five-hour', label: '5 h' },
      { id: 'week', label: 'semaine' },
      { id: 'week-opus', label: 'semaine · Opus' },
    ],
  };

  const open = (over: { stops?: UsageStops; clis?: (typeof CLAUDE)[]; critical?: number } = {}) => {
    const onSave = vi.fn<(stops: UsageStops) => void>();
    render(
      <UsageThresholds
        thresholds={{ warn: 80, critical: over.critical ?? 95 }}
        onSave={vi.fn()}
        {...{
          stopSettings: { stops: over.stops ?? {}, clis: over.clis ?? [CLAUDE], onSave },
        }}
      />,
    );
    const section = screen.getByRole('group', { name: 'Arrêt' });
    return { onSave, section };
  };
  const field = (scope: HTMLElement, name: RegExp) =>
    within(scope).getByRole<HTMLInputElement>('spinbutton', { name });
  const type = async (input: HTMLElement, value: string) => {
    await userEvent.clear(input);
    if (value !== '') await userEvent.type(input, value);
  };

  it('Given the settings, When they open, Then each window of the CLI has a field at 90 % by default (sc. 1)', () => {
    const { section } = open();
    expect(field(section, /^5 h : arrêt à/).value).toBe('90');
    expect(field(section, /^semaine : arrêt à/).value).toBe('90');
    expect(within(section).getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('Given saved thresholds, When the settings open, Then the fields show them and the other windows stay at 90 %', () => {
    const { section } = open({ stops: { 'claude-code': { week: 80 } } });
    expect(field(section, /^semaine : arrêt à/).value).toBe('80');
    expect(field(section, /^5 h : arrêt à/).value).toBe('90');
  });

  it('Given several CLIs, When the settings open, Then each one has its own row of fields, the windows per model included', () => {
    const { section } = open({ clis: [CLAUDE, CODEX] });
    const claude = within(section).getByRole('group', { name: 'Claude Code' });
    const codex = within(section).getByRole('group', { name: 'Codex' });
    expect(within(claude).getAllByRole('spinbutton')).toHaveLength(2);
    expect(within(codex).getAllByRole('spinbutton')).toHaveLength(3);
    expect(field(codex, /^semaine · Opus : arrêt à/).value).toBe('90');
  });

  it('Given the fields, When the settings open, Then each one is a number field from 10 to 100 with its own label', () => {
    const { section } = open();
    for (const input of within(section).getAllByRole<HTMLInputElement>('spinbutton')) {
      expect(input.getAttribute('min')).toBe('10');
      expect(input.getAttribute('max')).toBe('100');
      expect(input.labels).toHaveLength(1);
    }
  });

  it('Given the section, When it shows, Then it says the save is asked 3 points before', () => {
    const { section } = open();
    expect(within(section).getByText('Sauvegarde demandée 3 points avant.')).toBeTruthy();
  });

  it('Given a new value for the week, When the user saves, Then the thresholds are handed over with the week at 80 % and the 5 h window at 90 %', async () => {
    const { onSave, section } = open();
    await type(field(section, /^semaine : arrêt à/), '80');
    await userEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [stops] = onSave.mock.calls[0] ?? [];
    expect(stopOf(stops ?? {}, 'claude-code', 'week')).toBe(80);
    expect(stopOf(stops ?? {}, 'claude-code', 'five-hour')).toBe(90);
  });

  it.each(['10', '100'])(
    'Given %s %, When the user saves, Then it is accepted (the bounds are in)',
    async (value) => {
      const { onSave, section } = open();
      await type(field(section, /^5 h : arrêt à/), value);
      const save = within(section).getByRole('button', { name: 'Enregistrer' });
      expect(save).toHaveProperty('disabled', false);
      await userEvent.click(save);
      const [stops] = onSave.mock.calls[0] ?? [];
      expect(stopOf(stops ?? {}, 'claude-code', 'five-hour')).toBe(Number(value));
    },
  );

  it.each(['9', '101', '0', '50.5', ''])(
    'Given %j, When the user types it, Then « Enregistrer » is disabled and « Entre 10 et 100 % » shows',
    async (value) => {
      const { onSave, section } = open();
      await type(field(section, /^5 h : arrêt à/), value);
      expect(within(section).getByRole('button', { name: 'Enregistrer' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(within(section).getByText('Entre 10 et 100 %')).toBeTruthy();
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it('Given valid values, When the section shows, Then it does not say « Entre 10 et 100 % »', () => {
    const { section } = open();
    expect(within(section).queryByText('Entre 10 et 100 %')).toBeNull();
  });

  it('Given 100 %, When the user types it, Then the section says PACT no longer stops before a limit error', async () => {
    const { section } = open();
    const note = /À 100 %, PACT n['’]arrête plus avant une erreur de limite\./;
    expect(within(section).queryByText(note)).toBeNull();
    await type(field(section, /^5 h : arrêt à/), '100');
    expect(within(section).getByText(note)).toBeTruthy();
  });

  it('Given a threshold below the critical level of 95 %, When the section shows, Then it warns that the gauge will no longer turn red for its agents (O3)', async () => {
    const { section } = open();
    const note =
      /PACT arrête avant le niveau critique \(95 %\) : la jauge ne passera plus au rouge pour ses agents\./;
    // 90 % by default is already below 95 %.
    expect(within(section).getByText(note)).toBeTruthy();
    await type(field(section, /^5 h : arrêt à/), '100');
    await type(field(section, /^semaine : arrêt à/), '100');
    expect(within(section).queryByText(note)).toBeNull();
  });

  it('Given a critical level of 85 %, When thresholds are at 90 %, Then the note about the critical level is absent and it names the level in use otherwise', async () => {
    const { section } = open({ critical: 85 });
    expect(within(section).queryByText(/niveau critique/)).toBeNull();
    await type(field(section, /^5 h : arrêt à/), '80');
    expect(within(section).getByText(/niveau critique \(85 %\)/)).toBeTruthy();
  });
});
