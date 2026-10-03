import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileActions } from '../../../../src/renderer/tiles/TileActions';
import type { AgentState } from '../../../../src/shared/model';

// 002 T018 — « Revue → » for an agent with changes to review (FR-002).

const handlers = () => ({
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
});

describe('TileActions « Revue → »', () => {
  it.each<AgentState>(['done', 'awaiting-prompt'])(
    'opens the review of an agent %s',
    async (state) => {
      const user = userEvent.setup();
      const onReview = vi.fn();
      render(<TileActions state={state} {...handlers()} onReview={onReview} />);
      await user.click(screen.getByRole('button', { name: 'Revue →' }));
      expect(onReview).toHaveBeenCalled();
    },
  );

  it('is absent without changes to review', () => {
    render(<TileActions state="done" {...handlers()} />);
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
  });

  it('leaves the answer buttons alone while the agent asks something', () => {
    render(<TileActions state="awaiting-answer" {...handlers()} onReview={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
    expect(screen.getByRole('button', { name: '✓ Autoriser' })).toBeDefined();
  });
});
