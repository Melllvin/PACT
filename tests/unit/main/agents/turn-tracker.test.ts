import { describe, expect, it } from 'vitest';
import { TurnTracker } from '../../../../src/main/agents/turn-tracker';

// A report handed in just before the `working` event of its own turn must be kept (003 follow-up
// « fix-todo-diff-notifications »): the event is not a new turn.

describe('TurnTracker', () => {
  it('Given a report handed in just before the working event of its turn, When the event arrives, Then it is late and the report is kept', () => {
    const turns = new TurnTracker();
    turns.observe('a1', 'awaiting-prompt');
    turns.reported('a1', 'working');
    expect(turns.observe('a1', 'working')).toBe(true);
  });

  it('Given that late event already seen, When the next working event arrives, Then it is a new turn', () => {
    const turns = new TurnTracker();
    turns.observe('a1', 'done');
    turns.reported('a1', 'working');
    expect(turns.observe('a1', 'working')).toBe(true);
    turns.observe('a1', 'done');
    expect(turns.observe('a1', 'working')).toBe(false);
  });

  it('Given an agent already seen working, When it hands in a report, Then the next working event is not late', () => {
    const turns = new TurnTracker();
    turns.observe('a1', 'working');
    turns.reported('a1', 'working');
    expect(turns.observe('a1', 'working')).toBe(false);
  });

  it('Given a report of an agent that is not working, When its working event arrives, Then it is not late', () => {
    const turns = new TurnTracker();
    turns.reported('a1', 'done');
    expect(turns.observe('a1', 'working')).toBe(false);
  });

  it('Given an agent that is closed, When the same id comes back working, Then nothing of the old agent is kept', () => {
    const turns = new TurnTracker();
    turns.observe('a1', 'working');
    turns.observe('a1', 'closed');
    // Its last state was forgotten: a report ahead of the working event is late again.
    turns.reported('a1', 'working');
    expect(turns.observe('a1', 'working')).toBe(true);
  });

  it('Given a report waiting for a working event, When the agent is closed, Then the wait is dropped', () => {
    const turns = new TurnTracker();
    turns.observe('a1', 'awaiting-prompt');
    turns.reported('a1', 'working');
    turns.observe('a1', 'closed');
    expect(turns.observe('a1', 'working')).toBe(false);
  });
});
