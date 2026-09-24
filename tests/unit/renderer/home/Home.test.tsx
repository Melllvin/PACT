import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Home, type HomeProps } from '../../../../src/renderer/home/Home';
import type { Agent, RecentProject, Workspace } from '../../../../src/shared/model';

const now = new Date('2026-09-24T10:00:00.000Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const agent = (n: number, state: Agent['state'], color: Agent['color']): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color,
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(n)}`,
  worktreePath: `/w/.worktrees/claude-code-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state,
  lastError: null,
  scheduledResume: null,
});

const atelier: Workspace = {
  id: 'w1',
  path: '/Users/me/code/atelier-web',
  name: 'atelier-web',
  mainBranch: 'main',
  agents: [agent(1, 'awaiting-answer', 'purple'), agent(2, 'working', 'cyan')],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: now.toISOString(),
  status: 'available',
};

const recents: RecentProject[] = [
  {
    path: atelier.path,
    name: 'atelier-web',
    branch: 'main',
    keptWorktrees: 0,
    lastOpenedAt: now.toISOString(),
  },
  {
    path: '/Users/me/code/design-docs',
    name: 'design-docs',
    branch: 'develop',
    keptWorktrees: 1,
    lastOpenedAt: '2026-09-20T10:00:00.000Z',
  },
  {
    path: '/Users/me/code/mobile-shell',
    name: 'mobile-shell',
    branch: 'main',
    keptWorktrees: 0,
    lastOpenedAt: '2026-09-15T09:00:00.000Z',
  },
];

const renderHome = (overrides: Partial<HomeProps> = {}) => {
  const props: HomeProps = {
    workspaces: [atelier],
    recents,
    now,
    openError: null,
    clone: null,
    onGoTo: vi.fn(),
    onOpenPath: vi.fn(),
    onInitRepo: vi.fn(),
    onPickRepository: vi.fn(),
    onPickCloneDestination: vi.fn(() => Promise.resolve('/Users/me/code/new')),
    onClone: vi.fn(),
    getPathForFile: (file) => `/dropped/${file.name}`,
    ...overrides,
  };
  render(<Home {...props} />);
  return props;
};

const section = (name: string) => screen.getByRole('region', { name });

describe('Home (1a)', () => {
  it('is titled « Ouvrir un workspace »', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'Ouvrir un workspace' })).toBeDefined();
  });

  it('lists open workspaces with path, branch, worktrees, agent pills and waiting count', () => {
    renderHome();
    const row = within(section('Déjà ouverts')).getByRole('listitem');
    expect(row.textContent).toContain('atelier-web');
    expect(row.textContent).toContain('/Users/me/code/atelier-web · main · 2 worktrees');
    expect(within(row).getAllByRole('img', { name: /Agent/ })).toHaveLength(2);
    expect(within(row).getByLabelText('1 agent en attente').textContent).toBe('◆ 1');
  });

  it('goes to the existing tab instead of opening the repository again (FR-004)', async () => {
    const props = renderHome();
    await userEvent.click(
      within(section('Déjà ouverts')).getByRole('button', { name: 'Aller à l’onglet' }),
    );
    expect(props.onGoTo).toHaveBeenCalledWith('w1');
  });

  it('lists recents that are not open, with kept worktrees or the last opening', () => {
    renderHome();
    const items = within(section('Récents')).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'design-docs',
      'mobile-shell',
    ]);
    expect(items[0]?.textContent).toContain('/Users/me/code/design-docs · develop');
    expect(items[0]?.textContent).toContain('1 worktree conservé');
    expect(items[1]?.textContent).toContain('ouvert il y a 9 j');
  });

  it('opens a recent project', async () => {
    const props = renderHome();
    const item = within(section('Récents')).getAllByRole('listitem')[1];
    await userEvent.click(within(item as HTMLElement).getByRole('button', { name: 'Ouvrir' }));
    expect(props.onOpenPath).toHaveBeenCalledWith('/Users/me/code/mobile-shell');
  });

  it('filters projects with « Rechercher… », ignoring case and accents', async () => {
    renderHome({
      recents: [
        ...recents,
        {
          path: '/Users/me/Développement/api',
          name: 'Élan',
          branch: 'main',
          keptWorktrees: 0,
          lastOpenedAt: now.toISOString(),
        },
      ],
    });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Rechercher…' }), 'elan');
    expect(within(section('Récents')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Déjà ouverts' })).toBeNull();
  });

  it('shows a plural for several kept worktrees and « aujourd’hui » for today', () => {
    renderHome({
      workspaces: [],
      recents: [
        {
          path: '/p',
          name: 'p',
          branch: 'main',
          keptWorktrees: 3,
          lastOpenedAt: now.toISOString(),
        },
      ],
    });
    expect(within(section('Récents')).getByRole('listitem').textContent).toContain(
      '3 worktrees conservés',
    );
    renderHome({
      workspaces: [],
      recents: [
        {
          path: '/q',
          name: 'q',
          branch: 'main',
          keptWorktrees: 0,
          lastOpenedAt: now.toISOString(),
        },
      ],
    });
    expect(screen.getAllByText(/ouvert aujourd’hui/)).toHaveLength(1);
  });

  it('opens a folder dropped on the drop zone', () => {
    const props = renderHome();
    const file = new File([''], 'mon-depot');
    fireEvent.drop(screen.getByText('Déposez un dossier Git ici'), {
      dataTransfer: { files: [file] },
    });
    expect(props.onOpenPath).toHaveBeenCalledWith('/dropped/mon-depot');
  });

  it('lets the user choose a repository folder', async () => {
    const props = renderHome();
    await userEvent.click(screen.getByRole('button', { name: 'Choisir un dépôt Git…' }));
    expect(props.onPickRepository).toHaveBeenCalled();
  });

  it('explains a refused folder and offers to initialize a repository (US1 scenario 5)', async () => {
    const props = renderHome({
      openError: {
        code: 'NOT_A_REPO',
        message: '« notes » n’est pas un dépôt Git.',
        path: '/Users/me/notes',
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('n’est pas un dépôt Git');
    await userEvent.click(within(alert).getByRole('button', { name: 'Initialiser un dépôt ici' }));
    expect(props.onInitRepo).toHaveBeenCalledWith('/Users/me/notes');
  });

  it('shows other opening errors without the init offer', () => {
    renderHome({ openError: { code: 'INTERNAL', message: 'Disque plein', path: '/x' } });
    expect(screen.getByRole('alert').textContent).toContain('Disque plein');
    expect(screen.queryByRole('button', { name: 'Initialiser un dépôt ici' })).toBeNull();
  });
});

describe('Clone dialog', () => {
  it('clones a URL into the chosen destination', async () => {
    const props = renderHome();
    await userEvent.click(screen.getByRole('button', { name: 'Cloner depuis une URL…' }));
    const dialog = screen.getByRole('dialog', { name: 'Cloner un dépôt' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'URL du dépôt' }),
      'git@github.com:me/app.git',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choisir…' }));
    expect(
      (within(dialog).getByRole('textbox', { name: 'Destination' }) as HTMLInputElement).value,
    ).toBe('/Users/me/code/new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cloner' }));
    expect(props.onClone).toHaveBeenCalledWith('git@github.com:me/app.git', '/Users/me/code/new');
  });

  it('cannot start without a URL and a destination', async () => {
    renderHome({ onPickCloneDestination: vi.fn(() => Promise.resolve(null)) });
    await userEvent.click(screen.getByRole('button', { name: 'Cloner depuis une URL…' }));
    expect(screen.getByRole('button', { name: 'Cloner' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the clone progress and errors', () => {
    renderHome({ clone: { status: 'running', percent: 42, phase: 'Réception d’objets' } });
    const progress = screen.getByRole('progressbar', { name: 'Clonage' });
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText(/Réception d’objets/)).toBeDefined();
  });

  it('shows a clear clone failure', () => {
    renderHome({ clone: { status: 'failed', message: 'Repository not found.' } });
    expect(screen.getByRole('alert').textContent).toContain('Repository not found.');
  });
});
