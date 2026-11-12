import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 008 T060 — the dialog of the settings, opened from the bar of the view, closes without saving.

const workspace: Workspace = {
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [agent(2, { state: 'done', role: 'dev' })],
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
};

describe('the settings dialog opened from the view', () => {
  it('Given the dialog open, When the user cancels, Then it closes and nothing is sent', async () => {
    const none = () => undefined;
    const onDeliverySettings = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace}
        terminals={{ attach: vi.fn(() => () => undefined) }}
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

    await userEvent.click(screen.getByRole('button', { name: 'Réglages de livraison' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Réglages de livraison' })).getByRole('button', {
        name: 'Annuler',
      }),
    );

    expect(screen.queryByRole('dialog', { name: 'Réglages de livraison' })).toBeNull();
    expect(onDeliverySettings).not.toHaveBeenCalled();
  });
});
