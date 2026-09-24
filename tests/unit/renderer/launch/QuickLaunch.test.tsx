import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuickLaunch, type QuickLaunchProps } from '../../../../src/renderer/launch/QuickLaunch';
import type { CliDefinition } from '../../../../src/shared/model';

// Screen 1c — mode rapide (FR-009, FR-010, US2 scenarios 2, 5, 7, 8).

const cli = (id: string, name: string, overrides: Partial<CliDefinition> = {}): CliDefinition => ({
  id,
  name,
  adapter: 'claude-code',
  command: id,
  resolvedPath: `/bin/${id}`,
  version: '1.0.0',
  origin: 'detected',
  status: 'installed',
  models: [],
  ...overrides,
});

const detected = [cli('claude-code', 'Claude Code'), cli('codex', 'Codex', { adapter: 'codex' })];

const renderLauncher = (props: Partial<QuickLaunchProps> = {}) => {
  const onLaunch = vi.fn();
  const onClose = vi.fn();
  render(
    <QuickLaunch
      clis={detected}
      counters={{ freeTerminal: 0 }}
      existingAgents={0}
      error={null}
      onLaunch={onLaunch}
      onClose={onClose}
      {...props}
    />,
  );
  return { onLaunch, onClose };
};

const row = (name: string) => screen.getByRole('group', { name });
const count = (name: string) => within(row(name)).getByRole('status').textContent;

describe('QuickLaunch', () => {
  it('offers a counter per installed CLI, « Autre CLI » and « Terminal libre »', () => {
    renderLauncher({
      clis: [...detected, cli('gemini', 'Gemini', { status: 'missing', resolvedPath: null })],
    });
    expect(row('Claude Code')).toBeDefined();
    expect(row('Codex')).toBeDefined();
    expect(row('Autre CLI…')).toBeDefined();
    expect(row('Terminal libre')).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Gemini' })).toBeNull();
  });

  it('starts with one agent of the first CLI when nothing was launched here yet', () => {
    renderLauncher();
    expect(count('Claude Code')).toBe('1');
    expect(count('Codex')).toBe('0');
    expect(screen.getByRole('button', { name: 'Lancer 1 agent' })).toBeDefined();
  });

  it('starts from the counters last used in this workspace (FR-010)', () => {
    renderLauncher({ counters: { freeTerminal: 1, 'claude-code': 2, codex: 1 } });
    expect(count('Claude Code')).toBe('2');
    expect(count('Codex')).toBe('1');
    expect(count('Terminal libre')).toBe('1');
    expect(screen.getByRole('button', { name: 'Lancer 3 agents' })).toBeDefined();
  });

  it('launches what the counters say', async () => {
    const user = userEvent.setup();
    const { onLaunch } = renderLauncher();
    await user.click(within(row('Claude Code')).getByRole('button', { name: '+' }));
    await user.click(within(row('Codex')).getByRole('button', { name: '+' }));
    await user.click(within(row('Terminal libre')).getByRole('button', { name: '+' }));
    await user.click(screen.getByRole('button', { name: 'Lancer 3 agents' }));
    expect(onLaunch).toHaveBeenCalledWith({
      agents: { 'claude-code': 2, codex: 1 },
      freeTerminal: 1,
    });
  });

  it('never goes below zero', async () => {
    const user = userEvent.setup();
    renderLauncher();
    const minus = within(row('Codex')).getByRole('button', { name: '−' });
    expect((minus as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(row('Claude Code')).getByRole('button', { name: '−' }));
    expect(count('Claude Code')).toBe('0');
    expect(
      (screen.getByRole('button', { name: 'Lancer 0 agent' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('opens a free terminal alone', async () => {
    const user = userEvent.setup();
    const { onLaunch } = renderLauncher({ counters: { freeTerminal: 1, 'claude-code': 0 } });
    await user.click(screen.getByRole('button', { name: 'Ouvrir 1 terminal' }));
    expect(onLaunch).toHaveBeenCalledWith({ agents: {}, freeTerminal: 1 });
  });

  it('stops at six agents per workspace (US2 scenario 8)', async () => {
    const user = userEvent.setup();
    renderLauncher({ existingAgents: 4 });
    await user.click(within(row('Codex')).getByRole('button', { name: '+' }));
    expect(
      (within(row('Codex')).getByRole('button', { name: '+' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/6 agents au plus/)).toBeDefined();
  });

  it('limits the workflow to « Libre »', () => {
    renderLauncher();
    const workflow = screen.getByRole('combobox', { name: 'Workflow' });
    expect(
      within(workflow)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Libre']);
  });

  it('launches the first added CLI through « Autre CLI… », disabled without one', async () => {
    const user = userEvent.setup();
    const aider = cli('custom-aider', 'Aider', { adapter: 'generic', origin: 'custom' });
    const { onLaunch } = renderLauncher({
      clis: [...detected, aider],
      counters: { freeTerminal: 0, codex: 0 },
    });
    await user.click(within(row('Autre CLI…')).getByRole('button', { name: '+' }));
    await user.click(screen.getByRole('button', { name: 'Lancer 1 agent' }));
    expect(onLaunch).toHaveBeenCalledWith({ agents: { 'custom-aider': 1 }, freeTerminal: 0 });
  });

  it('disables « Autre CLI… » until a CLI is added', () => {
    renderLauncher();
    expect(
      (within(row('Autre CLI…')).getByRole('button', { name: '+' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says so when no agent CLI is installed', () => {
    renderLauncher({ clis: [] });
    expect(screen.getByText(/Aucun CLI d’agent détecté/)).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Lancer 0 agent' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows why a launch was refused', () => {
    renderLauncher({ error: 'Six agents au plus par projet.' });
    expect(screen.getByRole('alert').textContent).toBe('Six agents au plus par projet.');
  });

  it('closes with Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderLauncher();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
