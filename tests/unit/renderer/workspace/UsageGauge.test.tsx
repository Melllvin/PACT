import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UsageGauge,
  UsageGauges,
  workspaceGauges,
} from '../../../../src/renderer/workspace/UsageGauge';
import type { UsageReading, UsageState } from '../../../../src/shared/usage';

// 005 T012 — the gauge of a CLI account in the bar of the workspace (FR-001 to FR-009).

const NOW = new Date('2026-11-03T14:00:00');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  cliId: 'claude-code',
  account: 'default',
  readAt: minutesAgo(1),
  windows: [
    {
      id: 'five-hour',
      label: '5 h',
      usedPercent: 62,
      resetsAt: new Date('2026-11-03T16:40:00').toISOString(),
      minutes: 300,
    },
    {
      id: 'week',
      label: 'semaine',
      usedPercent: 18,
      resetsAt: new Date('2026-11-07T09:00:00').toISOString(),
      minutes: 10_080,
    },
  ],
  ...over,
});
const state = (
  over: Partial<UsageState> = {},
  read: Partial<UsageReading> = {},
): UsageState & { reading: UsageReading } => ({
  cliId: 'claude-code',
  account: 'default',
  shares: [],
  level: 'ok',
  ...over,
  reading: reading(read),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageGauge', () => {
  it('shows the CLI, the percentage and the window used the most', () => {
    render(<UsageGauge state={state()} cliName="Claude Code" now={NOW} />);
    // The same name whether the bar shows the long or the short form (narrow windows).
    expect(screen.getByRole('button', { name: 'Claude Code 62 % · 5 h' })).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Limite d’usage Claude Code' });
    expect(meter.getAttribute('aria-valuenow')).toBe('62');
    expect(meter.getAttribute('aria-valuetext')).toBe('62 % de la fenêtre 5 h');
  });

  it('tells the level in its name and its color', () => {
    render(<UsageGauge state={state({ level: 'warn' })} cliName="Claude Code" now={NOW} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuetext')).toBe(
      '62 % de la fenêtre 5 h, proche de la limite',
    );
    expect(meter.dataset.level).toBe('warn');
  });

  it('opens its detail on hover, on click and with the keyboard', async () => {
    render(<UsageGauge state={state()} cliName="Claude Code" now={NOW} />);
    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);
    const detail = screen.getByRole('region', { name: 'Détail de l’usage Claude Code' });
    expect(detail.textContent).toContain('5 h : 62 % · réinitialisation 16:40');
    expect(detail.textContent).toMatch(/semaine : 18 % · réinitialisation samedi 7 novembre 09:00/);
    expect(detail.textContent).toContain('Lu à 13:59');
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('region')).toBeNull();

    await userEvent.tab();
    expect(screen.getByRole('region')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region')).toBeNull();
    // A click keeps it open, another one closes it.
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a window whose reset time has passed as reset', () => {
    const late = new Date('2026-11-03T17:00:00');
    render(
      <UsageGauge state={state({}, { readAt: late.toISOString() })} cliName="Codex" now={late} />,
    );
    expect(screen.getByRole('button', { name: /Codex 18 % · semaine/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('region').textContent).toContain('5 h : 0 % · réinitialisée');
  });

  it('greys out a reading older than 15 minutes, with its age', () => {
    render(
      <UsageGauge state={state({}, { readAt: minutesAgo(20) })} cliName="Claude Code" now={NOW} />,
    );
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('lu il y a 20 min');
    expect(button.getAttribute('aria-label')).toBe('Claude Code 62 % · 5 h, lu il y a 20 min');
    expect(button.className).toContain('opacity-50');
  });

  it('keeps a short form for a narrow window', () => {
    render(<UsageGauge state={state()} cliName="Claude Code" now={NOW} />);
    expect(document.querySelector('.usage-gauge-short')?.textContent).toBe('62 %');
  });
});

describe('workspaceGauges', () => {
  const agents = (...cliIds: string[]) => ({ agents: cliIds.map((cliId) => ({ cliId })) });

  it('keeps the accounts of the CLIs of the workspace read less than an hour ago', () => {
    const codex = state({ cliId: 'codex' }, { cliId: 'codex' });
    const old = state({ account: '/autre' }, { readAt: minutesAgo(61) });
    const none = { ...state({ account: '/vide' }), reading: null };
    expect(
      workspaceGauges(agents('claude-code') as never, [state(), codex, old, none], NOW),
    ).toEqual([state()]);
  });
});

describe('UsageGauges', () => {
  it('shows nothing without a reading, a gauge per account otherwise', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const workspace = { agents: [{ cliId: 'claude-code' }] } as never;
    const clis = [{ id: 'claude-code', name: 'Claude Code' }];
    const { rerender } = render(<UsageGauges workspace={workspace} usage={[]} clis={clis} />);
    expect(screen.queryByRole('group', { name: 'Limites d’usage' })).toBeNull();
    rerender(<UsageGauges workspace={workspace} usage={[state()]} clis={clis} />);
    expect(screen.getByRole('group', { name: 'Limites d’usage' }).textContent).toContain(
      'Claude Code 62 % · 5 h',
    );
  });
});
