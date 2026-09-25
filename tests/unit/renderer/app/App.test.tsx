import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import type { CliDefinition, Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

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

describe('App terminals', () => {
  const exitedShell = async (terminals?: { attach: () => () => void; dispose: () => void }) => {
    const shell = {
      id: '00000000-0000-4000-8000-000000000007',
      workspaceId: 'w1',
      cwd: '/w1',
      shell: '/bin/zsh',
    };
    let exit: (event: { termId: string; code: number | null }) => void = () => undefined;
    const store = createAppStore({
      invoke: vi.fn(() =>
        Promise.resolve({
          workspaces: [{ ...workspace('w1', 'w1'), freeTerminals: [shell] }],
          recents: [],
          clis: [],
          permission: null,
        }),
      ),
      on: (channel: string, listener: typeof exit) => {
        if (channel === 'term:exit') exit = listener;
        return () => undefined;
      },
    } as unknown as PactApi);
    render(<App store={store} getPathForFile={() => ''} terminals={terminals} />);
    await screen.findByRole('article', { name: 'Terminal libre' });
    act(() => {
      exit({ termId: shell.id, code: 0 });
    });
    return shell.id;
  };

  it('removes the tile of an exited shell even without terminals to free', async () => {
    await exitedShell();
    expect(screen.queryByRole('article', { name: 'Terminal libre' })).toBeNull();
  });

  it('frees the terminal of a free terminal that is gone', async () => {
    const shell = {
      id: '00000000-0000-4000-8000-000000000007',
      workspaceId: 'w1',
      cwd: '/w1',
      shell: '/bin/zsh',
    };
    let exit: (event: { termId: string; code: number | null }) => void = () => undefined;
    const store = createAppStore({
      invoke: vi.fn(() =>
        Promise.resolve({
          workspaces: [{ ...workspace('w1', 'w1'), freeTerminals: [shell] }],
          recents: [],
          clis: [],
          permission: null,
        }),
      ),
      on: (channel: string, listener: typeof exit) => {
        if (channel === 'term:exit') exit = listener;
        return () => undefined;
      },
    } as unknown as PactApi);
    const terminals = { attach: vi.fn(() => () => undefined), dispose: vi.fn() };
    render(<App store={store} getPathForFile={() => ''} terminals={terminals} />);
    expect(await screen.findByRole('article', { name: 'Terminal libre' })).toBeDefined();
    act(() => {
      exit({ termId: shell.id, code: 0 });
    });
    expect(screen.queryByRole('article', { name: 'Terminal libre' })).toBeNull();
    expect(terminals.dispose).toHaveBeenCalledWith(shell.id);
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

describe('App launch flow (US2)', () => {
  type Invoke = (channel: string, input?: unknown) => Promise<unknown>;
  const fake: CliDefinition = {
    id: 'fake',
    name: 'Faux CLI',
    adapter: 'fake',
    command: 'node',
    resolvedPath: '/bin/node',
    version: 'v24.0.0',
    origin: 'detected',
    status: 'installed',
    models: [],
  };
  const setup = (workspaces: Workspace[], clis: CliDefinition[] = [fake]) => {
    const invoke = vi.fn<Invoke>((channel) => {
      switch (channel) {
        case 'app:getState':
          return Promise.resolve({ workspaces, recents: [], clis, permission: null });
        case 'cli:redetect':
          return Promise.resolve([fake]);
        default:
          return Promise.resolve(undefined);
      }
    });
    const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
    render(<App store={store} getPathForFile={() => ''} />);
    return invoke;
  };

  it('launches from « Ajouter des agents » through the permissions dialog', async () => {
    const invoke = setup([workspace('w1', 'w1')]);
    await userEvent.click(await screen.findByRole('button', { name: /Ajouter des agents/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Lancer 1 agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer 1 agent' }));
    expect(invoke).toHaveBeenCalledWith('permission:set', {
      level: 'always-allow',
      autoResume: true,
      scope: 'global',
    });
    expect(invoke).toHaveBeenCalledWith(
      'agents:launch',
      expect.objectContaining({ workspaceId: 'w1', freeTerminals: 0 }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('describes the permission levels for the launched CLIs only', async () => {
    const codex: CliDefinition = { ...fake, id: 'codex', name: 'Codex', adapter: 'codex' };
    const claude: CliDefinition = {
      ...fake,
      id: 'claude-code',
      name: 'Claude Code',
      status: 'missing',
    };
    setup([workspace('w1', 'w1')], [fake, codex, claude]);
    await userEvent.click(await screen.findByRole('button', { name: /Ajouter des agents/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Lancer 1 agent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Autorisations des agents' });
    expect(dialog.textContent).toContain('Faux CLI');
    expect(dialog.textContent).not.toMatch(/Codex|Claude Code/);
  });

  it('closes the launcher and the permissions dialog', async () => {
    setup([workspace('w1', 'w1')]);
    await userEvent.click(await screen.findByRole('button', { name: /Ajouter des agents/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Ajouter des agents/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Lancer 1 agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('detects the CLIs again from the home tab', async () => {
    const invoke = setup([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Détecter à nouveau' }));
    expect(invoke).toHaveBeenCalledWith('cli:redetect');
  });
});

describe('App tile actions (US3)', () => {
  type Invoke = (channel: string, input?: unknown) => Promise<unknown>;
  const failed = agent(1, { cliId: 'aider', state: 'error' });
  const setup = (agents = [failed]) => {
    const invoke = vi.fn<Invoke>((channel) => {
      switch (channel) {
        case 'app:getState':
          return Promise.resolve({
            workspaces: [{ ...workspace('w1', 'w1'), agents }],
            recents: [],
            clis: [],
            permission: null,
          });
        case 'agent:log':
          return Promise.resolve('Erreur simulée');
        default:
          return Promise.resolve(undefined);
      }
    });
    const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
    render(<App store={store} getPathForFile={() => ''} />);
    return invoke;
  };

  it('resumes and restarts an agent from its tile', async () => {
    const invoke = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Reprendre' }));
    await userEvent.click(screen.getByRole('button', { name: 'Relancer' }));
    expect(invoke).toHaveBeenCalledWith('agent:resume', { agentId: failed.id });
    expect(invoke).toHaveBeenCalledWith('agent:restart', { agentId: failed.id });
  });

  it('cancels the scheduled resume of an agent from its tile (FR-036)', async () => {
    const scheduledResume = { agentId: failed.id, at: '2030-01-01T09:30:00.000Z', attempt: 0 };
    const limited = {
      ...failed,
      lastError: { code: null, kind: 'rate-limit' as const, message: 'Limite' },
      scheduledResume,
    };
    const invoke = setup([limited]);
    const tiles = await screen.findByRole('region', { name: 'Tuiles' });
    await userEvent.click(within(tiles).getByRole('button', { name: 'Annuler' }));
    expect(invoke).toHaveBeenCalledWith('agent:cancelAutoResume', { agentId: failed.id });
  });

  it('answers an agent from its tile', async () => {
    const invoke = setup([{ ...failed, state: 'awaiting-answer' }]);
    const tiles = await screen.findByRole('region', { name: 'Tuiles' });
    await userEvent.click(within(tiles).getByRole('button', { name: '✓ Autoriser' }));
    expect(invoke).toHaveBeenCalledWith('agent:answer', { agentId: failed.id, answer: 'allow' });
  });

  it('opens « Journal » for the agent and closes it', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Journal' }));
    const panel = await screen.findByRole('dialog', { name: 'Journal de aider 1' });
    expect(panel.textContent).toContain('Erreur simulée');
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before closing an agent, then closes it with the choice made (FR-037)', async () => {
    const invoke = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Fermer l’agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Fermer aider 1' });
    await userEvent.click(screen.getByRole('radio', { name: /Supprimer/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Fermer l’agent' }));
    expect(invoke).toHaveBeenCalledWith('agent:close', {
      agentId: failed.id,
      removeWorktree: true,
    });
    expect(await screen.findByRole('button', { name: /Ajouter des agents/ })).toBeDefined();
  });

  it('cancels closing an agent', async () => {
    const invoke = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Fermer l’agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('agent:close', expect.anything());
  });
});
