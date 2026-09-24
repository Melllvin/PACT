import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Legend } from '../../../../src/renderer/app/Legend';
import { TabBar } from '../../../../src/renderer/app/TabBar';
import { Toolbar } from '../../../../src/renderer/app/Toolbar';

const tabs = [
  { id: 'w1', name: 'atelier-web' },
  { id: 'w2', name: 'api-facturation' },
];

describe('TabBar', () => {
  it('shows one tab per open workspace and marks the active one', () => {
    render(
      <TabBar
        workspaces={tabs}
        activeTab={{ kind: 'workspace', id: 'w2' }}
        onSelect={vi.fn()}
        onHome={vi.fn()}
      />,
    );
    const list = screen.getByRole('tablist');
    const [first, second] = within(list).getAllByRole('tab');
    expect(first?.textContent).toBe('atelier-web');
    expect(second?.textContent).toBe('api-facturation');
    expect(second?.getAttribute('aria-selected')).toBe('true');
    expect(first?.getAttribute('aria-selected')).toBe('false');
  });

  it('selects a workspace tab when clicked', async () => {
    const onSelect = vi.fn();
    render(
      <TabBar
        workspaces={tabs}
        activeTab={{ kind: 'home' }}
        onSelect={onSelect}
        onHome={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'api-facturation' }));
    expect(onSelect).toHaveBeenCalledWith('w2');
  });

  it('opens the home tab with « + » (FR-002)', async () => {
    const onHome = vi.fn();
    render(
      <TabBar
        workspaces={tabs}
        activeTab={{ kind: 'workspace', id: 'w1' }}
        onSelect={vi.fn()}
        onHome={onHome}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Nouvel onglet' }));
    expect(onHome).toHaveBeenCalled();
  });

  it('shows the home tab as selected while it is open', () => {
    render(
      <TabBar workspaces={tabs} activeTab={{ kind: 'home' }} onSelect={vi.fn()} onHome={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: 'Nouvel onglet' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('keeps the settings button visible but inactive in the core', () => {
    render(
      <TabBar workspaces={[]} activeTab={{ kind: 'home' }} onSelect={vi.fn()} onHome={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Réglages' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Toolbar', () => {
  it('offers Tuiles, Comparer, Revue, À faire and + Agents', () => {
    render(<Toolbar todoCount={0} onAddAgents={vi.fn()} />);
    for (const name of [/Tuiles/, /Comparer/, /Revue/, /À faire/, /\+ Agents/]) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
  });

  it('keeps Comparer and Revue visible but inactive (FR-006)', () => {
    render(<Toolbar todoCount={0} onAddAgents={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Comparer/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Revue/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Tuiles/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the number of pending items on À faire', () => {
    render(<Toolbar todoCount={3} onAddAgents={vi.fn()} />);
    expect(screen.getByRole('button', { name: /À faire/ }).textContent).toContain('3');
  });

  it('asks to add agents', async () => {
    const onAddAgents = vi.fn();
    render(<Toolbar todoCount={0} onAddAgents={onAddAgents} />);
    await userEvent.click(screen.getByRole('button', { name: /\+ Agents/ }));
    expect(onAddAgents).toHaveBeenCalled();
  });
});

describe('Toolbar without launcher', () => {
  it('disables + Agents until an action is wired (quick launch comes with US2)', () => {
    render(<Toolbar todoCount={0} />);
    expect(screen.getByRole('button', { name: /\+ Agents/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Legend', () => {
  it('explains every status icon (FR-041)', () => {
    render(<Legend />);
    const text = screen.getByRole('note').textContent;
    for (const item of ['◆ attend', '✓ prêt', '✕ erreur', '⎇ branche'])
      expect(text).toContain(item);
  });
});

describe('TabBar closing', () => {
  it('closes a workspace tab with its ✕ button', async () => {
    const onClose = vi.fn();
    render(
      <TabBar
        workspaces={tabs}
        activeTab={{ kind: 'workspace', id: 'w1' }}
        onSelect={vi.fn()}
        onHome={vi.fn()}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fermer api-facturation' }));
    expect(onClose).toHaveBeenCalledWith('w2');
  });
});

describe('home tab (1a)', () => {
  it('can be closed back to the workspaces when some are open', async () => {
    const onCloseHome = vi.fn();
    render(
      <TabBar
        workspaces={tabs}
        activeTab={{ kind: 'home' }}
        onSelect={vi.fn()}
        onHome={vi.fn()}
        onCloseHome={onCloseHome}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fermer Nouvel onglet' }));
    expect(onCloseHome).toHaveBeenCalled();
  });

  it('cannot be closed when it is the only tab', () => {
    render(
      <TabBar
        workspaces={[]}
        activeTab={{ kind: 'home' }}
        onSelect={vi.fn()}
        onHome={vi.fn()}
        onCloseHome={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Fermer Nouvel onglet' })).toBeNull();
  });
});
