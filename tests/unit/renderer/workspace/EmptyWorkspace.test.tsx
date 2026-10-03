import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import type { Workspace } from '../../../../src/shared/model';

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  path: '/Users/me/code/api-facturation',
  name: 'api-facturation',
  mainBranch: 'main',
  agents: [],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
  ...overrides,
});

describe('empty workspace (1b)', () => {
  it('offers a single action: « + Ajouter des agents »', () => {
    render(<WorkspaceView workspace={workspace()} onAddAgents={vi.fn()} />);
    const main = screen.getByRole('region', { name: 'api-facturation' });
    expect(
      within(main)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['+Ajouter des agents']);
  });

  it('opens the same launcher as « + Agents »', async () => {
    const onAddAgents = vi.fn();
    render(<WorkspaceView workspace={workspace()} onAddAgents={onAddAgents} />);
    await userEvent.click(screen.getByRole('button', { name: /Ajouter des agents/ }));
    await userEvent.click(screen.getByRole('button', { name: /\+ Agents/ }));
    expect(onAddAgents).toHaveBeenCalledTimes(2);
  });

  it('has no À faire column nor button before the first agent (FR-006)', () => {
    render(<WorkspaceView workspace={workspace()} onAddAgents={vi.fn()} />);
    expect(screen.queryByRole('complementary', { name: 'À faire' })).toBeNull();
    expect(screen.queryByRole('button', { name: /À faire/ })).toBeNull();
  });

  it('keeps Comparer and Revue visible but greyed out (FR-006)', () => {
    render(<WorkspaceView workspace={workspace()} onAddAgents={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Comparer' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('radio', { name: 'Revue' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables the actions until the launcher exists', () => {
    render(<WorkspaceView workspace={workspace()} />);
    expect(
      screen.getByRole('button', { name: /Ajouter des agents/ }).hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('unavailable workspace', () => {
  it('explains that the folder is gone and offers no action on it', () => {
    render(
      <WorkspaceView workspace={workspace({ status: 'unavailable' })} onAddAgents={vi.fn()} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Dossier introuvable');
    expect(alert.textContent).toContain('/Users/me/code/api-facturation');
    expect(screen.queryByRole('button', { name: /Ajouter des agents/ })).toBeNull();
    expect(screen.getByRole('button', { name: /\+ Agents/ }).hasAttribute('disabled')).toBe(true);
  });
});
