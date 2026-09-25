import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DetailedLaunch,
  type DetailedLaunchProps,
} from '../../../../src/renderer/launch/DetailedLaunch';
import { draftFromCounts, type LaunchDraft } from '../../../../src/shared/launch-draft';
import type { Agent, CliDefinition } from '../../../../src/shared/model';

// T096 — screen 1d, mode détaillé: master-detail (FR-011, US6 scenarios 2 to 5).

const cli = (id: string, name: string, models: string[]): CliDefinition => ({
  id,
  name,
  adapter: id === 'codex' ? 'codex' : 'claude-code',
  command: id,
  resolvedPath: `/bin/${id}`,
  version: '1.0.0',
  origin: 'detected',
  status: 'installed',
  models,
});

const clis = [
  cli('claude-code', 'Claude Code', ['opus', 'sonnet']),
  cli('codex', 'Codex', ['gpt-5-codex', 'gpt-5']),
];

type HarnessProps = Partial<Omit<DetailedLaunchProps, 'draft' | 'onChange'>> & {
  initial?: LaunchDraft;
  onDraft?: (draft: LaunchDraft) => void;
};

/** The draft lives above the panel (LaunchPanel); this keeps it the same way. */
function Harness({ initial, onDraft, ...props }: HarnessProps) {
  const [draft, setDraft] = useState(initial ?? draftFromCounts({ 'claude-code': 2, codex: 1 }, 0));
  return (
    <DetailedLaunch
      clis={clis}
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onDraft?.(next);
      }}
      running={[]}
      taken={[]}
      error={null}
      onLaunch={vi.fn()}
      onQuick={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />
  );
}

const setup = (props: HarnessProps = {}) => {
  const user = userEvent.setup();
  let last: LaunchDraft | undefined;
  render(
    <Harness
      {...props}
      onDraft={(draft) => {
        last = draft;
      }}
    />,
  );
  return { user, draft: () => last };
};

const list = () => screen.getByRole('list', { name: 'Agents' });
const items = () => within(list()).getAllByRole('listitem');
/** The button that selects the agent at `index` (0-based) in the list. */
const agent = (index: number) =>
  within(items()[index] as HTMLElement).getByRole('button', { name: /^(Claude Code|Codex)/ });
const inspector = () => screen.getByRole('region', { name: 'Inspecteur' });
const field = (name: string) => within(inspector()).getByRole('group', { name });
const inherited = (name: string) => field(name).dataset.inherited === 'true';
const cliNames = () =>
  items().map((item) => within(item).getByRole('button', { name: /^(Claude Code|Codex)/ }));

describe('DetailedLaunch', () => {
  it('lists « Commun à tous » and the agents, each in the color of its future tile', () => {
    setup({ running: [{ position: 1, color: 'purple' }] });
    expect(screen.getByRole('button', { name: /Commun à tous/ })).toBeDefined();
    expect(screen.getByText('Agents · 3')).toBeDefined();
    expect(items().map((item) => item.style.getPropertyValue('--agent-color'))).toEqual([
      'var(--agent-cyan)',
      'var(--agent-green)',
      'var(--agent-magenta)',
    ]);
    expect(cliNames().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Claude Code'),
      expect.stringContaining('Claude Code'),
      expect.stringContaining('Codex'),
    ]);
  });

  it('shows the common settings first', () => {
    setup();
    expect(within(inspector()).getByRole('heading', { name: 'Commun à tous' })).toBeDefined();
    for (const name of ['Modèle', 'Permissions', 'Branche de base', 'Commande']) {
      expect(field(name)).toBeDefined();
    }
  });

  it('inspects an agent: CLI, model, permissions, base branch, branch, port and command', async () => {
    const { user } = setup();
    await user.click(agent(2));
    expect(within(inspector()).getByRole('heading', { name: 'Codex' })).toBeDefined();
    expect(
      within(field('CLI'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Claude Code', 'Codex']);
    expect(
      within(field('Modèle'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Par défaut du CLI', 'gpt-5-codex', 'gpt-5']);
    expect(
      within(field('Permissions'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Demander', 'Auto · worktree', 'Tout auto']);
    expect(within(field('Branche')).getByRole('textbox')).toHaveProperty(
      'placeholder',
      'auto — choisie par l’agent',
    );
    expect(within(field('Port')).getByRole('textbox')).toHaveProperty('placeholder', 'auto');
    expect(field('Branche de base')).toBeDefined();
    expect(field('Commande')).toBeDefined();
  });

  it('applies a common setting to every agent that does not override it (US6 scenario 2)', async () => {
    const { user, draft } = setup();
    await user.click(within(field('Permissions')).getByRole('button', { name: 'Tout auto' }));
    expect(draft()?.common.permissionLevel).toBe('always-allow');
    await user.click(agent(0));
    const allAuto = within(field('Permissions')).getByRole('button', { name: 'Tout auto' });
    expect(allAuto.getAttribute('aria-pressed')).toBe('true');
    expect(inherited('Permissions')).toBe(true);
  });

  it('marks an override with ≠, counts it on the agent, and goes back to the common value (US6 scenario 3)', async () => {
    const { user, draft } = setup();
    await user.click(agent(2));
    expect(inherited('Modèle')).toBe(true);
    await user.selectOptions(within(field('Modèle')).getByRole('combobox'), 'gpt-5');
    await user.click(within(field('Permissions')).getByRole('button', { name: 'Demander' }));
    expect(inherited('Modèle')).toBe(false);
    expect(within(field('Modèle')).getByLabelText('diffère du commun')).toBeDefined();
    expect(within(items()[2] as HTMLElement).getByText('≠ 2')).toBeDefined();
    expect(draft()?.agents[2]?.overrides).toEqual({
      model: 'gpt-5',
      permissionLevel: 'always-ask',
    });

    await user.click(within(field('Modèle')).getByRole('button', { name: 'Revenir au commun' }));
    expect(inherited('Modèle')).toBe(true);
    expect(within(items()[2] as HTMLElement).getByText('≠ 1')).toBeDefined();
  });

  it('sets the branch and the port of one agent only', async () => {
    const { user, draft } = setup();
    await user.click(agent(1));
    await user.type(within(field('Branche')).getByRole('textbox'), 'feature/login');
    await user.type(within(field('Port')).getByRole('textbox'), '4000');
    expect(draft()?.agents[1]).toMatchObject({ branch: 'feature/login', port: 4000 });
    expect(within(items()[1] as HTMLElement).getByText(/feature\/login · :4000/)).toBeDefined();
    expect(draft()?.agents[0]).toMatchObject({ branch: null, port: null });
  });

  it('changes the CLI of an agent', async () => {
    const { user, draft } = setup();
    await user.click(agent(0));
    await user.selectOptions(within(field('CLI')).getByRole('combobox'), 'codex');
    expect(draft()?.agents[0]?.cliId).toBe('codex');
  });

  it('duplicates and removes the selected agent (US6 scenario 4)', async () => {
    const { user } = setup();
    await user.click(agent(2));
    await user.click(within(inspector()).getByRole('button', { name: 'Dupliquer' }));
    expect(items()).toHaveLength(4);
    expect(cliNames().map((b) => b.textContent)).toEqual([
      expect.stringContaining('Claude Code'),
      expect.stringContaining('Claude Code'),
      expect.stringContaining('Codex'),
      expect.stringContaining('Codex'),
    ]);
    await user.click(agent(0));
    await user.click(within(inspector()).getByRole('button', { name: 'Retirer' }));
    expect(items()).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Lancer 3 agents' })).toBeDefined();
  });

  it('adds an agent, up to six in the workspace', async () => {
    const { user } = setup({ running: [1, 2].map((position) => ({ position }) as Agent) });
    const add = screen.getByRole('button', { name: '+ Ajouter un agent' });
    await user.click(add);
    expect(items()).toHaveLength(4);
    expect(add.hasAttribute('disabled')).toBe(true);
  });

  it('moves an agent with the keyboard; colors follow the order (US6 scenario 4)', async () => {
    const { user, draft } = setup();
    within(items()[2] as HTMLElement)
      .getByRole('button', { name: 'Déplacer Codex' })
      .focus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(draft()?.agents.map((a) => a.cliId)).toEqual(['codex', 'claude-code', 'claude-code']);
    expect(items()[0]?.style.getPropertyValue('--agent-color')).toBe('var(--agent-purple)');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Déplacer Codex');
  });

  it('moves an agent by drag and drop', () => {
    let last: LaunchDraft | undefined;
    render(
      <Harness
        onDraft={(draft) => {
          last = draft;
        }}
      />,
    );
    const handle = within(items()[2] as HTMLElement).getByRole('button', {
      name: 'Déplacer Codex',
    });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(items()[0] as HTMLElement, { dataTransfer });
    fireEvent.drop(items()[0] as HTMLElement, { dataTransfer });
    expect(last?.agents.map((a) => a.cliId)).toEqual(['codex', 'claude-code', 'claude-code']);
  });

  it('blocks the launch while two agents share a branch or a port (US6 scenario 5)', async () => {
    const onLaunch = vi.fn();
    const { user } = setup({ onLaunch, taken: [{ branch: 'main-work', port: 3005 }] });
    await user.click(agent(0));
    await user.type(within(field('Branche')).getByRole('textbox'), 'feature/x');
    await user.click(agent(1));
    await user.type(within(field('Branche')).getByRole('textbox'), 'feature/x');
    await user.type(within(field('Port')).getByRole('textbox'), '3005');
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toEqual([
      expect.stringContaining('« feature/x »'),
      expect.stringContaining('3005'),
    ]);
    const launch = screen.getByRole('button', { name: 'Lancer 3 agents' });
    expect(launch.hasAttribute('disabled')).toBe(true);
    await user.click(launch);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('launches, goes back to the quick mode, or cancels', async () => {
    const onLaunch = vi.fn();
    const onQuick = vi.fn();
    const onClose = vi.fn();
    const { user } = setup({ onLaunch, onQuick, onClose });
    await user.click(screen.getByRole('button', { name: 'Lancer 3 agents' }));
    await user.click(screen.getByRole('button', { name: '← Mode rapide' }));
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(onQuick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows why main refused the launch (BRANCH_CONFLICT, PORT_CONFLICT)', () => {
    setup({ error: 'La branche « feature/x » existe déjà.' });
    expect(screen.getByRole('alert').textContent).toBe('La branche « feature/x » existe déjà.');
  });

  it('groups the settings of an agent as 1d does: Agent, Git, Aperçu', async () => {
    const { user } = setup();
    await user.click(agent(2));
    expect(
      within(inspector())
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(['Agent', 'Git', 'Aperçu']);
  });

  it('keeps the focus inside the panel (modal dialog)', async () => {
    const { user } = setup();
    const dialog = screen.getByRole('dialog', { name: 'Lancer des agents' });
    for (let step = 0; step < 20; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('explains its marks', () => {
    setup();
    expect(screen.getByText(/≠ diffère du commun · pointillés = hérité/)).toBeDefined();
  });
});
