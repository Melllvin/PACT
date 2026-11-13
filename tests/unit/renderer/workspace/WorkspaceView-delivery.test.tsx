import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 008 T022 — « Livrer » / « Intégrer » on the tile of a dev: what the workspace gives it.

const dev = agent(2, { state: 'done', role: 'dev', branch: 'feat/connexion' });
const tester = agent(3, { state: 'done', role: 'test' });

const workspaceOf = (extra: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [dev, tester],
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
  workflow: { lastValid: null, error: null, readAt: null },
  runs: [],
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
  ...extra,
});

const loop = {
  issueId: '0012-connexion',
  devAgentId: dev.id,
  testAgentId: tester.id,
  state: 'accepted',
};
const issue = { id: '0012-connexion', title: 'Connexion par e-mail', state: 'ready' };

const none = () => undefined;
const actions = (onRequestDelivery = vi.fn()) => ({
  onAnswer: none,
  onResume: none,
  onRestart: none,
  onLog: none,
  onCancelAutoResume: none,
  onClose: none,
  onRequestDelivery,
});
const terminals = { attach: vi.fn(() => () => undefined) };
const tile = () => screen.getByRole('article', { name: /^claude-code 2,/ });

describe('the delivery actions of the tile of a dev', () => {
  it('Given an accepted loop and a remote, When « Livrer » is sent, Then the request carries the title of the issue', async () => {
    const user = userEvent.setup();
    const onRequestDelivery = vi.fn();
    render(
      <WorkspaceView
        workspace={workspaceOf({
          hasOrigin: true,
          loops: [loop] as never,
          issues: [issue] as never,
        })}
        terminals={terminals}
        actions={actions(onRequestDelivery)}
      />,
    );

    await user.click(within(tile()).getByRole('button', { name: 'Livrer' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /message/i }), 'feat: connexion');
    await user.click(within(dialog).getByRole('button', { name: 'Demander' }));

    expect(onRequestDelivery).toHaveBeenCalledWith(dev.id, {
      title: 'Connexion par e-mail',
      message: 'feat: connexion',
      unverified: false,
    });
  });

  it('Given no remote and a loop whose issue is gone, When the tile is read, Then « Intégrer » is offered and the title is the branch', async () => {
    const user = userEvent.setup();
    const onRequestDelivery = vi.fn();
    render(
      <WorkspaceView
        workspace={workspaceOf({ loops: [loop] as never })}
        terminals={terminals}
        actions={actions(onRequestDelivery)}
      />,
    );

    await user.click(within(tile()).getByRole('button', { name: 'Intégrer' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmer' }));

    expect(onRequestDelivery).toHaveBeenCalledWith(dev.id, {
      title: 'feat/connexion',
      message: 'feat/connexion',
      unverified: false,
    });
  });

  it('Given a delivery under way, a tester or no handler, When the tiles are read, Then no delivery action is offered', () => {
    const running = {
      agentId: dev.id,
      testAgentId: tester.id,
      state: 'watching',
    };
    const { rerender } = render(
      <WorkspaceView
        workspace={workspaceOf({ deliveries: [running] as never })}
        terminals={terminals}
        actions={actions()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Livrer|Intégrer/ })).toBeNull();

    rerender(<WorkspaceView workspace={workspaceOf()} terminals={terminals} actions={actions()} />);
    expect(within(tile()).queryByRole('button', { name: 'Intégrer' })).not.toBeNull();
    expect(
      within(screen.getByRole('article', { name: /^claude-code 3,/ })).queryByRole('button', {
        name: /Livrer|Intégrer/,
      }),
    ).toBeNull();

    rerender(<WorkspaceView workspace={workspaceOf()} terminals={terminals} />);
    expect(screen.queryByRole('button', { name: /Livrer|Intégrer/ })).toBeNull();
  });
});
