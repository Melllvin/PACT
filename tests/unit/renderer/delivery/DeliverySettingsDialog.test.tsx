import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 008 T056 — the dialog « Réglages de livraison » (contracts/ui.md, US5 sc.7, FR-020): the mode of merge, the
// ceiling of round trips (1–10, default 3), the polish passes (0–5, default 0) and the brief (≤ 2000), saved
// explicitly, out-of-bounds values refused with the message of the field.
//
// RED until T060 creates `src/renderer/delivery/DeliverySettingsDialog.tsx` and T060 opens it from DeliveryBar.
// Assumed API (ui.md gives the fields, not the props; the simplest form, as CloseAgentDialog):
//   <DeliverySettingsDialog
//     settings={{ mergeMode, maxRounds, polishPasses, polishBrief }}   the current ones, `workspace.delivery`
//     onSave={(settings: { mergeMode; maxRounds; polishPasses; polishBrief }) => void}
//                                                                      only on « Enregistrer », only if valid;
//                                                                      `auto` is the bar’s switch, not sent
//     onCancel={() => void}                                            « Annuler » and Escape
//   />
//   A dialog named « Réglages de livraison » with: a radio group « Mode de fusion » (radios « Squash »,
//   « Merge commit », « Rebase »), spinbuttons « Plafond d’allers-retours » (min 1, max 10) and « Passes de
//   peaufinage » (min 0, max 5), a textbox « Consigne de peaufinage » (maxLength 2000), buttons « Enregistrer »
//   and « Annuler ». An invalid field is `aria-invalid="true"` and a `role="alert"` message names its bounds
//   (« 1 à 10 », « 0 à 5 », « 2000 »); nothing is saved while one is invalid.
//   WorkspaceView passes `onOpenSettings` to DeliveryBar, shows the dialog fed by `workspace.delivery`, and sends
//   the saved values by `actions.onDeliverySettings(settings)`.

type Settings = {
  mergeMode: 'squash' | 'merge' | 'rebase';
  maxRounds: number;
  polishPasses: number;
  polishBrief: string;
};
type DialogProps = {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onCancel: () => void;
};

// The module does not exist yet: loaded by a variable path so that the red tests fail on what is missing
// (see `setup`), not on an import that hides it, and the type check passes. T060 may keep a plain import.
const PATH = '../../../../src/renderer/delivery/DeliverySettingsDialog';
const loaded = (await import(/* @vite-ignore */ PATH).catch(() => null)) as {
  DeliverySettingsDialog?: ComponentType<DialogProps>;
} | null;

const DEFAULTS: Settings = { mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' };

const setup = (settings: Partial<Settings> = {}) => {
  const DeliverySettingsDialog = loaded?.DeliverySettingsDialog;
  if (!DeliverySettingsDialog) {
    throw new Error(
      'DeliverySettingsDialog manque : src/renderer/delivery/DeliverySettingsDialog.tsx (T060)',
    );
  }
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <DeliverySettingsDialog
      settings={{ ...DEFAULTS, ...settings }}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return {
    onSave,
    onCancel,
    rounds: () => screen.getByRole('spinbutton', { name: 'Plafond d’allers-retours' }),
    passes: () => screen.getByRole('spinbutton', { name: 'Passes de peaufinage' }),
    brief: () => screen.getByRole('textbox', { name: 'Consigne de peaufinage' }),
    save: () => screen.getByRole('button', { name: 'Enregistrer' }),
  };
};

const type = async (field: HTMLElement, value: string) => {
  await userEvent.clear(field);
  if (value !== '') await userEvent.type(field, value);
};

describe('the fields and their defaults (contracts/ui.md)', () => {
  it('Given the default settings, When the dialog opens, Then it shows Squash, 3 round trips, 0 passes and an empty brief', () => {
    const { rounds, passes, brief } = setup();

    expect(screen.getByRole('dialog', { name: 'Réglages de livraison' })).toBeDefined();
    const mode = screen.getByRole('radiogroup', { name: 'Mode de fusion' });
    expect(
      within(mode)
        .getByRole('radio', { name: /Squash/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(mode).getByRole('radio', { name: /Merge commit/ })).toBeDefined();
    expect(within(mode).getByRole('radio', { name: /Rebase/ })).toBeDefined();
    expect((rounds() as HTMLInputElement).value).toBe('3');
    expect((passes() as HTMLInputElement).value).toBe('0');
    expect((brief() as HTMLTextAreaElement).value).toBe('');
  });

  it('Given the bounds of the contract, When the fields are read, Then the ceiling is 1–10, the passes 0–5 and the brief 2000 characters', () => {
    const { rounds, passes, brief } = setup();

    expect(rounds().getAttribute('min')).toBe('1');
    expect(rounds().getAttribute('max')).toBe('10');
    expect(passes().getAttribute('min')).toBe('0');
    expect(passes().getAttribute('max')).toBe('5');
    expect(brief().getAttribute('maxlength')).toBe('2000');
  });

  it('Given saved settings, When the dialog opens, Then it shows them, not the defaults (sc.7: kept)', () => {
    const { rounds, passes, brief } = setup({
      mergeMode: 'rebase',
      maxRounds: 5,
      polishPasses: 1,
      polishBrief: 'Renomme les variables',
    });

    expect(screen.getByRole('radio', { name: /Rebase/ }).getAttribute('aria-checked')).toBe('true');
    expect((rounds() as HTMLInputElement).value).toBe('5');
    expect((passes() as HTMLInputElement).value).toBe('1');
    expect((brief() as HTMLTextAreaElement).value).toBe('Renomme les variables');
  });
});

describe('saving is explicit (sc.7)', () => {
  it('Given a mode, a ceiling of 5 and 1 pass typed, When the user clicks « Enregistrer », Then the four values go out together, and not before', async () => {
    const user = userEvent.setup();
    const { onSave, rounds, passes, brief, save } = setup();

    await user.click(screen.getByRole('radio', { name: /Merge commit/ }));
    await type(rounds(), '5');
    await type(passes(), '1');
    await user.click(brief());
    await user.paste('Corrige les noms');
    expect(onSave).not.toHaveBeenCalled();
    await user.click(save());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      mergeMode: 'merge',
      maxRounds: 5,
      polishPasses: 1,
      polishBrief: 'Corrige les noms',
    });
  });

  it('Given values untouched, When the user clicks « Enregistrer », Then the current settings go out unchanged', async () => {
    const { onSave, save } = setup({ maxRounds: 7 });

    await userEvent.click(save());

    expect(onSave).toHaveBeenCalledWith({ ...DEFAULTS, maxRounds: 7 });
  });

  it('Given edits, When the user cancels or presses Escape, Then nothing is saved', async () => {
    const { onSave, onCancel, rounds } = setup();
    await type(rounds(), '8');

    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await userEvent.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Given the boundaries themselves, When the user saves 1 and 10, then 0 and 5, Then they are accepted', async () => {
    const { onSave, rounds, passes, save } = setup();

    await type(rounds(), '1');
    await type(passes(), '5');
    await userEvent.click(save());
    await type(rounds(), '10');
    await type(passes(), '0');
    await userEvent.click(save());

    expect(onSave).toHaveBeenNthCalledWith(1, { ...DEFAULTS, maxRounds: 1, polishPasses: 5 });
    expect(onSave).toHaveBeenNthCalledWith(2, { ...DEFAULTS, maxRounds: 10, polishPasses: 0 });
  });
});

describe('values out of bounds are refused with the message of the field (sc.7)', () => {
  it.each([
    ['a ceiling of 0', 'rounds', '0', /1.*10/],
    ['a ceiling of 11', 'rounds', '11', /1.*10/],
    ['a ceiling of 2.5', 'rounds', '2.5', /1.*10/],
    ['an empty ceiling', 'rounds', '', /1.*10/],
    ['6 passes', 'passes', '6', /0.*5/],
    ['−1 pass', 'passes', '-1', /0.*5/],
    ['an empty number of passes', 'passes', '', /0.*5/],
  ] as const)(
    'Given %s, When the user saves, Then nothing is saved, the field is invalid and its message gives the bounds',
    async (_name, which, value, bounds) => {
      const fields = setup();
      const field = which === 'rounds' ? fields.rounds() : fields.passes();

      await type(field, value);
      await userEvent.click(fields.save());

      expect(fields.onSave).not.toHaveBeenCalled();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent).toMatch(bounds);
    },
  );

  it('Given a brief over 2000 characters, When the user saves, Then nothing is saved and the message gives the limit', async () => {
    const { onSave, brief, save } = setup();

    fireEvent.change(brief(), { target: { value: 'x'.repeat(2001) } });
    await userEvent.click(save());

    expect(onSave).not.toHaveBeenCalled();
    expect(brief().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('2000');
  });

  it('Given a refused value corrected, When the user saves again, Then it goes out and the message is gone', async () => {
    const { onSave, rounds, save } = setup();
    await type(rounds(), '11');
    await userEvent.click(save());
    expect(screen.getByRole('alert')).toBeDefined();

    await type(rounds(), '9');
    await userEvent.click(save());

    expect(onSave).toHaveBeenCalledWith({ ...DEFAULTS, maxRounds: 9 });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('opened from the bar of the workspace (ui.md)', () => {
  const dev = agent(2, { state: 'done', role: 'dev' });
  const workspaceOf = (delivery: Workspace['delivery']): Workspace => ({
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [dev],
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    testCommand: null,
    integrationRequests: [],
    delivery,
    deliveries: [],
    roleProfiles: {},
    issues: [],
    loops: [],
    testPaths: [...DEFAULT_TEST_PATHS],
    publishRequests: [],
    exchanges: { messages: [], escalations: [] },
    lastOpenedAt: '2026-09-24T10:00:00.000Z',
    status: 'available',
    hasOrigin: true,
  });
  const none = () => undefined;
  const terminals = { attach: vi.fn(() => () => undefined) };

  it('Given a workspace with its settings, When the user opens « Réglages de livraison », edits and saves, Then the dialog shows the saved values and the view sends the four values', async () => {
    const user = userEvent.setup();
    const onDeliverySettings = vi.fn();
    render(
      <WorkspaceView
        workspace={workspaceOf({
          auto: true,
          mergeMode: 'rebase',
          maxRounds: 4,
          polishPasses: 2,
          polishBrief: 'Brief du projet',
        })}
        terminals={terminals}
        actions={{
          onAnswer: none,
          onResume: none,
          onRestart: none,
          onLog: none,
          onCancelAutoResume: none,
          onClose: none,
          onDeliverySettings,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Réglages de livraison' }));
    const dialog = screen.getByRole('dialog', { name: 'Réglages de livraison' });
    const rounds = within(dialog).getByRole('spinbutton', { name: 'Plafond d’allers-retours' });
    expect((rounds as HTMLInputElement).value).toBe('4');
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Consigne de peaufinage',
      }).value,
    ).toBe('Brief du projet');
    await type(rounds, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    expect(onDeliverySettings).toHaveBeenCalledWith({
      mergeMode: 'rebase',
      maxRounds: 5,
      polishPasses: 2,
      polishBrief: 'Brief du projet',
    });
  });
});
