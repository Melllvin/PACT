import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryBar } from '../../../../src/renderer/delivery/DeliveryBar';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 008 T026 — the bar of the delivery and its « Auto » switch (contracts/ui.md, US2 sc.4, FR-019).
//
// RED until T030 creates `src/renderer/delivery/DeliveryBar.tsx`.
//
// API fixed here for the dev (ui.md gives the look, not the props; the simplest form):
//   <DeliveryBar
//     auto={boolean}                       the setting of the project, `workspace.delivery.auto`
//     hasOrigin={boolean}                  `workspace.hasOrigin`; false → the switch is disabled
//     onToggleAuto={(auto: boolean) => void}   the NEW value the user asks for
//     onOpenSettings={() => void}          « Réglages de livraison »
//   />
//   An element with role="switch" named « Auto », aria-checked = `auto`; its `title` is
//   « Auto : fusionne quand la CI est verte » (« Sans remote, la fusion reste confirmée par toi » when
//   there is no remote); a button named « Réglages de livraison ».
//   Mounted by WorkspaceView at the bottom of the view, fed by `workspace.delivery.auto` and
//   `workspace.hasOrigin`; the new value goes out by `actions.onDeliverySettings({ auto })`.

const setup = (props: Partial<React.ComponentProps<typeof DeliveryBar>> = {}) => {
  const onToggleAuto = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <DeliveryBar
      auto={false}
      hasOrigin
      onToggleAuto={onToggleAuto}
      onOpenSettings={onOpenSettings}
      {...props}
    />,
  );
  return { onToggleAuto, onOpenSettings, auto: () => screen.getByRole('switch', { name: /Auto/ }) };
};

describe('the Auto switch', () => {
  it('Given a project whose setting is off (the default), When the bar is shown, Then Auto is a switch that is off', () => {
    const { auto } = setup();

    expect(auto().getAttribute('aria-checked')).toBe('false');
    expect((auto() as HTMLButtonElement).disabled).toBe(false);
  });

  it('Given Auto off, When the user clicks the switch, Then it asks for Auto on, without showing it on before the setting comes back', async () => {
    const user = userEvent.setup();
    const { auto, onToggleAuto } = setup();

    await user.click(auto());

    expect(onToggleAuto).toHaveBeenCalledTimes(1);
    expect(onToggleAuto).toHaveBeenCalledWith(true);
    expect(auto().getAttribute('aria-checked')).toBe('false');
  });

  it('Given Auto on, When the user clicks the switch, Then it asks for Auto off', async () => {
    const user = userEvent.setup();
    const { auto, onToggleAuto } = setup({ auto: true });

    expect(auto().getAttribute('aria-checked')).toBe('true');
    await user.click(auto());

    expect(onToggleAuto).toHaveBeenCalledWith(false);
  });

  it('Given the keyboard, When the user presses Space on the switch, Then it toggles like a click', async () => {
    const user = userEvent.setup();
    const { auto, onToggleAuto } = setup();

    await user.tab();
    expect(document.activeElement).toBe(auto());
    await user.keyboard(' ');

    expect(onToggleAuto).toHaveBeenCalledWith(true);
  });

  it('Given a project with a remote, When the user looks at the switch, Then it says what Auto does', () => {
    const { auto } = setup();

    expect(auto().getAttribute('title')).toBe('Auto : fusionne quand la CI est verte');
  });

  it('Given a project without remote, When the bar is shown, Then the switch is disabled, says why and asks nothing', async () => {
    const user = userEvent.setup();
    const { auto, onToggleAuto } = setup({ hasOrigin: false });

    expect((auto() as HTMLButtonElement).disabled).toBe(true);
    expect(auto().getAttribute('title')).toBe('Sans remote, la fusion reste confirmée par toi');
    await user.click(auto());
    expect(onToggleAuto).not.toHaveBeenCalled();
  });
});

describe('the settings of the delivery', () => {
  it('Given the bar, When the user clicks « Réglages de livraison », Then the settings are asked for', async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = setup();

    await user.click(screen.getByRole('button', { name: 'Réglages de livraison' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('the bar under the workspace (sc.4: kept after a reload)', () => {
  const dev = agent(2, { state: 'done', role: 'dev' });
  const workspaceOf = (extra: Partial<Workspace> = {}): Workspace => ({
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
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
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
    ...extra,
  });
  const none = () => undefined;
  const actions = (onDeliverySettings = vi.fn()) => ({
    onAnswer: none,
    onResume: none,
    onRestart: none,
    onLog: none,
    onCancelAutoResume: none,
    onClose: none,
    onDeliverySettings,
  });
  const terminals = { attach: vi.fn(() => () => undefined) };

  it('Given a workspace whose saved setting is on, When the view is shown after a reload, Then Auto is on', () => {
    render(
      <WorkspaceView
        workspace={workspaceOf({
          delivery: {
            auto: true,
            mergeMode: 'squash',
            maxRounds: 3,
            polishPasses: 0,
            polishBrief: '',
          },
        })}
        terminals={terminals}
        actions={actions()}
      />,
    );

    expect(screen.getByRole('switch', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('Given a new workspace, When the user turns Auto on, Then the view sends only the setting that changed', async () => {
    const user = userEvent.setup();
    const onDeliverySettings = vi.fn();
    render(
      <WorkspaceView
        workspace={workspaceOf()}
        terminals={terminals}
        actions={actions(onDeliverySettings)}
      />,
    );
    const auto = screen.getByRole('switch', { name: /Auto/ });
    expect(auto.getAttribute('aria-checked')).toBe('false');

    await user.click(auto);

    expect(onDeliverySettings).toHaveBeenCalledWith({ auto: true });
  });

  it('Given a workspace without remote, When the view is shown, Then Auto is disabled', () => {
    render(
      <WorkspaceView
        workspace={workspaceOf({ hasOrigin: false })}
        terminals={terminals}
        actions={actions()}
      />,
    );

    expect(screen.getByRole('switch', { name: /Auto/ }).hasAttribute('disabled')).toBe(true);
  });
});
