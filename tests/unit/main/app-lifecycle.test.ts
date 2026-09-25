import { describe, expect, it, vi } from 'vitest';
import { guardQuit, quitQuestion } from '../../../src/main/app-lifecycle';

type Listener = (event: { preventDefault(): void }) => void;

const setup = (options: { active: number; answer?: boolean; skipConfirm?: boolean }) => {
  const listeners: Listener[] = [];
  const app = {
    on: vi.fn((name: string, listener: Listener) => {
      if (name === 'before-quit') listeners.push(listener);
    }),
    quit: vi.fn(),
  };
  const shutdown = vi.fn(() => Promise.resolve());
  const confirm = vi.fn(() => Promise.resolve(options.answer ?? true));
  guardQuit({
    app,
    activeAgents: () => options.active,
    confirm,
    shutdown,
    ...(options.skipConfirm ? { skipConfirm: true } : {}),
  });
  const quit = async () => {
    const event = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(event);
    await vi.waitFor(() => {
      expect(shutdown.mock.calls.length + confirm.mock.calls.length).toBeGreaterThan(0);
    });
    await Promise.resolve();
    await Promise.resolve();
    return event;
  };
  return { app, shutdown, confirm, quit, listeners };
};

// T110 — quitting with active agents asks first, and every PTY stops before the app exits.
describe('guardQuit', () => {
  it('asks before quitting while agents are active, naming how many', async () => {
    const { confirm, quit } = setup({ active: 2 });
    const event = await quit();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(2);
  });

  it('stops everything then quits once the user confirms', async () => {
    const { app, shutdown, quit } = setup({ active: 1, answer: true });
    await quit();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalled();
    });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      app.quit.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('keeps the app open and the agents running when the user cancels', async () => {
    const { app, shutdown, confirm, quit } = setup({ active: 3, answer: false });
    await quit();
    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalled();
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits without asking when no agent is active, still after a clean stop', async () => {
    const { app, shutdown, confirm, quit } = setup({ active: 0 });
    await quit();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalled();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('lets the second quit through once everything is stopped', async () => {
    const { app, listeners, quit } = setup({ active: 1 });
    await quit();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalled();
    });
    const again = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(again);
    expect(again.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a new quit while the question is open or the stop is running', () => {
    const { confirm, listeners } = setup({ active: 1 });
    const first = { preventDefault: vi.fn() };
    const again = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(first);
    for (const listener of listeners) listener(again);
    expect(again.preventDefault).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('skips the question in e2e runs, where no one can answer it', async () => {
    const { app, confirm, quit } = setup({ active: 2, skipConfirm: true });
    await quit();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalled();
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('quits even when a stop fails, so the app never hangs open', async () => {
    const { app, shutdown, quit } = setup({ active: 0 });
    shutdown.mockRejectedValueOnce(new Error('pty already gone'));
    await quit();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalled();
    });
  });
});

describe('quitQuestion', () => {
  it('names the active agents and says their state stays saved, Annuler by default', () => {
    const question = quitQuestion(2);
    expect(question.message).toBe('2 agents sont actifs. Quitter PACT ?');
    expect(question.detail).toMatch(/état reste enregistré/);
    expect(question.buttons).toEqual(['Quitter', 'Annuler']);
    expect(question.defaultId).toBe(1);
    expect(question.cancelId).toBe(1);
  });

  it('speaks of one agent in the singular', () => {
    expect(quitQuestion(1).message).toBe('1 agent est actif. Quitter PACT ?');
  });
});

describe('guardQuit deadline', () => {
  it('quits after the deadline when a stop never ends, so PACT never stays open', async () => {
    vi.useFakeTimers();
    try {
      const listeners: Listener[] = [];
      const app = {
        on: (_name: string, listener: Listener) => listeners.push(listener),
        quit: vi.fn(),
      };
      guardQuit({
        app,
        activeAgents: () => 0,
        confirm: () => Promise.resolve(true),
        shutdown: () => new Promise<void>(() => undefined),
        deadlineMs: 5000,
      });
      for (const listener of listeners) listener({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(4999);
      expect(app.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(app.quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
