import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import type { Workspace } from '../../../../src/shared/model';

const workspace = (id: string, name: string): Workspace => ({
  id,
  path: `/${name}`,
  name,
  mainBranch: 'main',
  agents: [],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

const storeWith = (workspaces: Workspace[]) =>
  createAppStore({
    invoke: vi.fn(() => Promise.resolve({ workspaces, recents: [], clis: [], permission: null })),
    on: () => () => undefined,
  } as unknown as PactApi);

describe('App', () => {
  it('names the application for assistive technologies', () => {
    render(<App store={storeWith([])} />);
    expect(screen.getByRole('heading', { level: 1, name: 'PACT' })).toBeDefined();
  });

  it('loads the state and shows the open workspaces as tabs', async () => {
    const store = storeWith([workspace('w1', 'atelier-web')]);
    render(<App store={store} />);
    expect(await screen.findByRole('tab', { name: 'atelier-web' })).toBeDefined();
    expect(screen.getByRole('toolbar')).toBeDefined();
  });

  it('hides the workspace toolbar on the home tab', async () => {
    const store = storeWith([workspace('w1', 'atelier-web')]);
    render(<App store={store} />);
    await screen.findByRole('tab', { name: 'atelier-web' });
    await userEvent.click(screen.getByRole('button', { name: 'Nouvel onglet' }));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('shows a loading error', async () => {
    const store = createAppStore({
      invoke: vi.fn(() => Promise.reject(new Error('Disque illisible'))),
      on: () => () => undefined,
    } as unknown as PactApi);
    render(<App store={store} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Disque illisible');
  });

  it('stops listening to the main process when unmounted', async () => {
    const off = vi.fn();
    const store = createAppStore({
      invoke: vi.fn(() =>
        Promise.resolve({ workspaces: [], recents: [], clis: [], permission: null }),
      ),
      on: () => off,
    } as unknown as PactApi);
    const { unmount } = render(<App store={store} />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(off).toHaveBeenCalled();
  });
});
