import { describe, expect, it, vi } from 'vitest';
import { applyTestMode, testClock } from '../../../src/main/test-mode';

const fakeApp = () => ({ setPath: vi.fn() });

describe('applyTestMode', () => {
  it('redirects userData to the directory given by the e2e harness', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_TEST_MODE: '1', PACT_USER_DATA_DIR: '/tmp/pact-e2e-x' });
    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/pact-e2e-x');
  });

  it('never touches userData outside test mode', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_USER_DATA_DIR: '/tmp/pact-e2e-x' });
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('keeps the default userData in test mode without a directory', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_TEST_MODE: '1' });
    expect(app.setPath).not.toHaveBeenCalled();
  });
});

// T106 — the e2e runs move the time of the scheduled resumes (US7) themselves.
describe('testClock', () => {
  const env = { PACT_TEST_MODE: '1', PACT_TEST_NOW: '2030-01-01T09:00:00.000Z' };

  it('starts at the time given by the e2e harness, and stays there', () => {
    const clock = testClock(env);
    expect(clock?.now().toISOString()).toBe('2030-01-01T09:00:00.000Z');
  });

  it('runs the due timers when the harness moves the time', () => {
    const clock = testClock(env);
    const early = vi.fn();
    const late = vi.fn();
    const cancelled = vi.fn();
    clock?.setTimeout(early, 60_000);
    clock?.setTimeout(late, 30 * 60_000);
    clock?.clearTimeout(clock.setTimeout(cancelled, 0));
    clock?.advanceTo('2030-01-01T09:01:00.000Z');
    expect(early).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
    clock?.advanceTo('2030-01-01T09:30:00.000Z');
    expect(late).toHaveBeenCalledOnce();
    expect(early).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(clock?.now().toISOString()).toBe('2030-01-01T09:30:00.000Z');
  });

  it('is the real time outside test mode or without a start time', () => {
    expect(testClock({ PACT_TEST_NOW: env.PACT_TEST_NOW })).toBeUndefined();
    expect(testClock({ PACT_TEST_MODE: '1' })).toBeUndefined();
  });
});
