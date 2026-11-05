import { afterEach, describe, expect, it, vi } from 'vitest';
import { within } from '../../../src/main/timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('within', () => {
  it('gives the result of a promise that answers in time', async () => {
    await expect(within(Promise.resolve(7), 5000)).resolves.toBe(7);
  });

  it('gives undefined once the time has passed, whatever the promise does later', async () => {
    vi.useFakeTimers();
    const silent = new Promise<number>(() => undefined);
    const result = within(silent, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    let done = false;
    void result.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
  });

  it('leaves no timer behind', async () => {
    vi.useFakeTimers();
    await within(Promise.resolve(1), 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
