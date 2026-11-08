import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../../../../src/renderer/focus/FocusView';
import { agent } from '../tiles/fixtures';

// 007 contracts/ui.md « Onglet ◎ Actions » — the journal is read from a file the agents write to:
// what does not parse is left out, and an agent that is gone shows as « ? ».

const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuidOf(100 + n),
  at: '2026-11-08T10:00:00.000Z',
  from: agent(2).id,
  to: agent(3).id,
  type: 'action',
  kind: 'message',
  text: `Message ${String(n)}`,
  unreadBy: [],
  ...over,
});

const shown = (messages: Record<string, unknown>[]) => {
  render(
    <FocusView
      agents={[agent(1, { role: 'orchestrator' }), agent(2), agent(3)]}
      agentId={agent(1).id}
      name={() => 'Claude Code'}
      terminals={undefined}
      tab="actions"
      onTab={vi.fn()}
      orchestration={{ actions: [], onRevoke: vi.fn(), messages }}
      onSelect={vi.fn()}
      onBack={vi.fn()}
      onAnswer={vi.fn()}
      onResume={vi.fn()}
      onRestart={vi.fn()}
      onLog={vi.fn()}
      onCancelAutoResume={vi.fn()}
    />,
  );
  return within(screen.getByRole('list', { name: 'Actions de l’orchestrateur' })).getAllByRole(
    'listitem',
  );
};

describe('FocusView, the journal of the orchestrator', () => {
  it('Given an entry that is not a message, When the journal is shown, Then only the valid message is there', () => {
    const items = shown([{ id: 'pas-un-uuid', text: 42 }, message(1)]);
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Message 1');
  });

  it('Given a message from and to agents that are gone, When it is shown, Then both are « ? »', () => {
    const [item] = shown([message(2, { from: uuidOf(77), to: uuidOf(78) })]);
    expect(item?.textContent).toMatch(/\?\s*→\s*\?/);
  });
});
