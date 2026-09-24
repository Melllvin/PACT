import { act, fireEvent, render, screen } from '@testing-library/react';
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
    render(<App store={storeWith([])} getPathForFile={() => ''} />);
    expect(screen.getByRole('heading', { level: 1, name: 'PACT' })).toBeDefined();
  });

  it('loads the state and shows the open workspaces as tabs', async () => {
    const store = storeWith([workspace('w1', 'atelier-web')]);
    render(<App store={store} getPathForFile={() => ''} />);
    expect(await screen.findByRole('tab', { name: 'atelier-web' })).toBeDefined();
    expect(screen.getByRole('toolbar')).toBeDefined();
  });

  it('shows the home screen on the home tab and the workspace on its tab', async () => {
    const store = storeWith([workspace('w1', 'atelier-web')]);
    render(<App store={store} getPathForFile={() => ''} />);
    expect(await screen.findByRole('region', { name: 'atelier-web' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Nouvel onglet' }));
    expect(screen.getByRole('heading', { name: 'Ouvrir un workspace' })).toBeDefined();
  });

  it('hides the workspace toolbar on the home tab', async () => {
    const store = storeWith([workspace('w1', 'atelier-web')]);
    render(<App store={store} getPathForFile={() => ''} />);
    await screen.findByRole('tab', { name: 'atelier-web' });
    await userEvent.click(screen.getByRole('button', { name: 'Nouvel onglet' }));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('shows a loading error', async () => {
    const store = createAppStore({
      invoke: vi.fn(() => Promise.reject(new Error('Disque illisible'))),
      on: () => () => undefined,
      pathForFile: () => '',
    });
    render(<App store={store} getPathForFile={() => ''} />);
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
    const { unmount } = render(<App store={store} getPathForFile={() => ''} />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(off).toHaveBeenCalled();
  });
});

describe('App wiring of the home actions', () => {
  type Invoke = (channel: string, input?: unknown) => Promise<unknown>;
  const setup = (workspaces: Workspace[] = []) => {
    const invoke = vi.fn<Invoke>((channel, input) => {
      switch (channel) {
        case 'app:getState':
          return Promise.resolve({
            workspaces,
            recents: [
              {
                path: '/code/old',
                name: 'old',
                branch: 'main',
                keptWorktrees: 0,
                lastOpenedAt: '2026-09-01T10:00:00.000Z',
              },
            ],
            clis: [],
            permission: null,
          });
        case 'dialog:pickFolder':
          return Promise.resolve('/code/picked');
        case 'workspace:open':
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the preload rejects plain objects (contextBridge)
          return Promise.reject({ code: 'NOT_A_REPO', message: 'Pas un dépôt Git.' });
        case 'workspace:initRepo':
          return Promise.resolve(workspace('w9', 'picked'));
        case 'workspace:clone':
          return Promise.resolve({ jobId: 'j1' });
        case 'workspace:close':
          return Promise.resolve(undefined);
        default:
          return Promise.reject(new Error(`unexpected ${channel} ${JSON.stringify(input)}`));
      }
    });
    const store = createAppStore({
      invoke,
      on: () => () => undefined,
      pathForFile: () => '',
    } as unknown as PactApi);
    render(<App store={store} getPathForFile={() => '/code/dropped'} />);
    return { invoke, store };
  };

  it('opens a recent, then initializes the refused folder', async () => {
    const { invoke } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Ouvrir' }));
    expect(invoke).toHaveBeenCalledWith('workspace:open', { path: '/code/old' });
    await userEvent.click(await screen.findByRole('button', { name: 'Initialiser un dépôt ici' }));
    expect(invoke).toHaveBeenCalledWith('workspace:initRepo', { path: '/code/old' });
    expect(await screen.findByRole('tab', { name: 'picked' })).toBeDefined();
  });

  it('picks a repository and resolves dropped folders', async () => {
    const { invoke } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Choisir un dépôt Git…' }));
    expect(invoke).toHaveBeenCalledWith('dialog:pickFolder', { purpose: 'open-repository' });
    const zone = screen.getByText('Déposez un dossier Git ici');
    fireEvent.drop(zone, { dataTransfer: { files: [new File([''], 'x')] } });
    expect(invoke).toHaveBeenCalledWith('workspace:open', { path: '/code/dropped' });
  });

  it('starts a clone from the dialog', async () => {
    const { invoke } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Cloner depuis une URL…' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'URL du dépôt' }), 'git@x:y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Choisir…' }));
    await screen.findByDisplayValue('/code/picked');
    await userEvent.click(screen.getByRole('button', { name: 'Cloner' }));
    expect(invoke).toHaveBeenCalledWith('workspace:clone', {
      url: 'git@x:y.git',
      destination: '/code/picked',
    });
  });

  it('goes to an open workspace from home and closes its tab', async () => {
    const { invoke } = setup([workspace('w1', 'atelier-web')]);
    await screen.findByRole('tab', { name: 'atelier-web' });
    await userEvent.click(screen.getByRole('button', { name: 'Nouvel onglet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Aller à l’onglet' }));
    expect(screen.getByRole('tab', { name: 'atelier-web' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fermer atelier-web' }));
    expect(invoke).toHaveBeenCalledWith('workspace:close', { id: 'w1' });
    expect(await screen.findByRole('heading', { name: 'Ouvrir un workspace' })).toBeDefined();
  });
});
