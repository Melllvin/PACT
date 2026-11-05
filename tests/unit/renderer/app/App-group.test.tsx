import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Agent, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 US4 — the dialogs of an orchestrator closed and restarted with its agents (FR-023 … FR-026).

type Invoke = (channel: string, input?: unknown) => Promise<unknown>;

const lead = agent(1, { role: 'orchestrator', cliId: 'fake' });
const sub = (n: number, state: Agent['state'] = 'awaiting-prompt') =>
  agent(n, { launchedBy: lead.id, cliId: 'fake', state });

const setup = (agents: Agent[]) => {
  const workspace: Workspace = {
    id: 'w1',
    path: '/w1',
    name: 'w1',
    mainBranch: 'main',
    agents,
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    testCommand: null,
    integrationRequests: [],
    roleProfiles: {},
    issues: [],
    loops: [],
    testPaths: [...DEFAULT_TEST_PATHS],
    publishRequests: [],
    lastOpenedAt: '2026-09-24T10:00:00.000Z',
    status: 'available',
  };
  const invoke = vi.fn<Invoke>((channel) =>
    channel === 'app:getState'
      ? Promise.resolve({ workspaces: [workspace], recents: [], clis: [], permission: null })
      : Promise.resolve(undefined),
  );
  const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
  render(<App store={store} getPathForFile={() => ''} />);
  return invoke;
};

describe('closing an orchestrator', () => {
  it('lists the agents that close with it', async () => {
    setup([lead, sub(2), sub(3)]);
    const [first] = await screen.findAllByRole('button', { name: 'Fermer l’agent' });
    await userEvent.click(first as HTMLElement);
    const dialog = screen.getByRole('dialog', { name: /^Fermer / });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('restarting a closed orchestrator', () => {
  const closedGroup = () => [
    { ...lead, state: 'closed' as const },
    sub(2, 'closed'),
    sub(3, 'closed'),
  ];

  it('asks for « Reprendre le travail » first, then restarts with the choice', async () => {
    const invoke = setup(closedGroup());
    const [first] = await screen.findAllByRole('button', { name: 'Relancer' });
    await userEvent.click(first as HTMLElement);
    const dialog = screen.getByRole('dialog', { name: /^Relancer / });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Reprendre le travail/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Relancer' }));
    expect(invoke).toHaveBeenCalledWith('agent:restart', {
      agentId: lead.id,
      resumeWork: false,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists only the agents closed with it, and cancels without restarting', async () => {
    const invoke = setup([{ ...lead, state: 'closed' }, sub(2, 'closed'), sub(3)]);
    const [first] = await screen.findAllByRole('button', { name: 'Relancer' });
    await userEvent.click(first as HTMLElement);
    const dialog = screen.getByRole('dialog', { name: /^Relancer / });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('agent:restart', expect.anything());
  });
});
