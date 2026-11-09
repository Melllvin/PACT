import { describe, expect, it, vi } from 'vitest';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import type { UsageState } from '../../../../src/shared/usage';
import { createAppStore } from '../../../../src/renderer/store/app-store';

// 005 — the usage of the CLI accounts and the alert thresholds in the store of the renderer.

const usageState = (cliId: string, percent: number): UsageState => ({
  cliId,
  account: 'default',
  reading: {
    cliId,
    account: 'default',
    readAt: '2026-11-03T14:00:00.000Z',
    windows: [
      { id: 'five-hour', label: '5 h', usedPercent: percent, resetsAt: null, minutes: 300 },
    ],
  },
  shares: [],
  level: 'ok',
});

function fakeApi(
  usage: () => Promise<UsageState[]>,
  stopsOf: () => Promise<unknown> = () => Promise.resolve({}),
) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn((channel: string, input?: unknown) => {
    if (channel === 'usage:get') return usage();
    if (channel === 'settings:usageThresholds') return Promise.resolve(input);
    if (channel === 'usage:stops') return stopsOf();
    if (channel === 'settings:usageStops') return Promise.resolve(input);
    return Promise.resolve({
      workspaces: [],
      recents: [],
      clis: [],
      permission: null,
      usageThresholds: { warn: 70, critical: 90 },
    });
  });
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
  } as unknown as PactApi;
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  return { api, invoke, emit };
}

describe('usage in the store', () => {
  it('loads the readings and the thresholds, then follows the new readings', async () => {
    const { api, emit } = fakeApi(() => Promise.resolve([usageState('claude-code', 40)]));
    const store = createAppStore(api);
    store.getState().connect();
    await store.getState().load();
    await vi.waitFor(() => {
      expect(Object.keys(store.getState().usage)).toEqual(['claude-code\u0000default']);
    });
    expect(store.getState().usageThresholds).toEqual({ warn: 70, critical: 90 });
    emit('usage:state', usageState('claude-code', 62));
    emit('usage:state', usageState('codex', 10));
    const usage = store.getState().usage;
    expect(usage['claude-code\u0000default']?.reading?.windows[0]?.usedPercent).toBe(62);
    expect(usage['codex\u0000default']).toBeDefined();
  });

  it('keeps a reading told before the list came back', async () => {
    let answer: (states: UsageState[]) => void = () => undefined;
    const { api, emit } = fakeApi(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const store = createAppStore(api);
    store.getState().connect();
    await store.getState().load();
    emit('usage:state', usageState('claude-code', 62));
    answer([usageState('claude-code', 40)]);
    await vi.waitFor(() => {
      expect(store.getState().status).toBe('ready');
    });
    await Promise.resolve();
    expect(
      store.getState().usage['claude-code\u0000default']?.reading?.windows[0]?.usedPercent,
    ).toBe(62);
  });

  it('opens the window even when the readings cannot be read', async () => {
    const { api } = fakeApi(() => Promise.reject(new Error('boom')));
    const store = createAppStore(api);
    await store.getState().load();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().usage).toEqual({});
  });

  it('saves new thresholds', async () => {
    const { api, invoke } = fakeApi(() => Promise.resolve([]));
    const store = createAppStore(api);
    await store.getState().load();
    await store.getState().setUsageThresholds({ warn: 60, critical: 85 });
    expect(invoke).toHaveBeenCalledWith('settings:usageThresholds', { warn: 60, critical: 85 });
    expect(store.getState().usageThresholds).toEqual({ warn: 60, critical: 85 });
  });

  it('loads the stop thresholds, and saves new ones (009 US4)', async () => {
    const stops = { 'claude-code': { week: 80 } };
    const { api, invoke } = fakeApi(
      () => Promise.resolve([]),
      () => Promise.resolve(stops),
    );
    const store = createAppStore(api);
    await store.getState().load();
    expect(store.getState().usageStops).toBeNull();
    await store.getState().loadUsageStops();
    expect(store.getState().usageStops).toEqual(stops);
    await store.getState().setUsageStops({ codex: { 'five-hour': 70 } });
    expect(invoke).toHaveBeenCalledWith('settings:usageStops', { codex: { 'five-hour': 70 } });
    expect(store.getState().usageStops).toEqual({ codex: { 'five-hour': 70 } });
  });
});
