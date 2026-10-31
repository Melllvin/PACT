import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventQueue } from '../../../../src/main/orchestrator/events';
import type { OrchestratorEvent } from '../../../../src/shared/orchestrator';

// 003 T025 — the events an orchestrator waits for (research R5).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (
  n: number,
  kind: OrchestratorEvent['kind'] = 'turn-finished',
): OrchestratorEvent => ({
  at: '2026-10-31T10:00:00.000Z',
  agentId: uuid(n),
  kind,
  state: 'done',
  summary: '',
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EventQueue', () => {
  it('ends a wait at the first event of the agents asked for', async () => {
    const queue = new EventQueue();
    const waiting = queue.wait([uuid(2)], 300_000);
    queue.push(event(3));
    queue.push(event(2));
    expect(await waiting).toEqual({ events: [event(2)], timedOut: false });
  });

  it('waits for any agent when none is named', async () => {
    const queue = new EventQueue();
    const waiting = queue.wait(undefined, 300_000);
    queue.push(event(4, 'error'));
    expect(await waiting).toEqual({ events: [event(4, 'error')], timedOut: false });
  });

  it('gives back at once the events that came between two waits, in order', async () => {
    const queue = new EventQueue();
    queue.push(event(2));
    queue.push(event(3, 'closed'));
    expect(await queue.wait(undefined, 300_000)).toEqual({
      events: [event(2), event(3, 'closed')],
      timedOut: false,
    });
  });

  it('keeps the events of other agents for a later wait', async () => {
    const queue = new EventQueue();
    queue.push(event(3));
    const waiting = queue.wait([uuid(2)], 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ events: [], timedOut: true });
    expect(await queue.wait([uuid(3)], 1000)).toEqual({ events: [event(3)], timedOut: false });
  });

  it('ends with timedOut once the delay is over', async () => {
    const queue = new EventQueue();
    const waiting = queue.wait(undefined, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    queue.push(event(2));
    expect(await waiting).toEqual({ events: [event(2)], timedOut: false });
    const late = queue.wait(undefined, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await late).toEqual({ events: [], timedOut: true });
  });

  it('replaces a wait by the next one, the first ending without events', async () => {
    const queue = new EventQueue();
    const first = queue.wait(undefined, 300_000);
    const second = queue.wait(undefined, 300_000);
    expect(await first).toEqual({ events: [], timedOut: false, replaced: true });
    queue.push(event(2));
    expect(await second).toEqual({ events: [event(2)], timedOut: false });
  });

  it('keeps 100 events at most, the oldest forgotten', async () => {
    const queue = new EventQueue();
    for (let n = 1; n <= 105; n++) queue.push(event(n));
    const { events } = await queue.wait(undefined, 1000);
    expect(events).toHaveLength(100);
    expect(events[0]).toEqual(event(6));
  });

  it('ends the wait in progress when closed', async () => {
    const queue = new EventQueue();
    const waiting = queue.wait(undefined, 300_000);
    queue.close();
    expect(await waiting).toEqual({ events: [], timedOut: false, replaced: true });
  });
});
