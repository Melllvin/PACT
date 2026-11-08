import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../../../../src/renderer/focus/FocusView';
import { agent } from '../tiles/fixtures';

// 006 #42 — Escape pressed on the terminal itself (not in a field) is left to the CLI.

describe('FocusView, Escape on the terminal', () => {
  it('does not go back when the key reaches the terminal container', () => {
    const onBack = vi.fn();
    const noop = vi.fn();
    render(
      <FocusView
        agents={[agent(1)]}
        agentId={agent(1).id}
        name={() => 'Claude Code'}
        terminals={{ attach: vi.fn(() => () => undefined) }}
        tab="terminal"
        onTab={noop}
        onSelect={noop}
        onBack={onBack}
        onAnswer={noop}
        onResume={noop}
        onRestart={noop}
        onLog={noop}
        onCancelAutoResume={noop}
        onClose={noop}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText('Terminal de Claude Code 1'), { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
  });
});
