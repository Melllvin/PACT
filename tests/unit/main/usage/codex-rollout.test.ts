import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexRollout,
  findRollout,
  lastRolloutSample,
  ROLLOUT_INTERVAL_MS,
} from '../../../../src/main/usage/codex-rollout';
import type { UsageSample } from '../../../../src/main/usage/sample';

// The file system is the real one until a test drives one of its calls by hand.
type Hook = (...args: unknown[]) => unknown;
const fsHooks = vi.hoisted(() => ({
  readdir: undefined as Hook | undefined,
  stat: undefined as Hook | undefined,
  readFile: undefined as Hook | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const through =
    (name: 'readdir' | 'stat' | 'readFile') =>
    (...args: unknown[]) =>
      (fsHooks[name] ?? (actual[name] as Hook))(...args);
  return {
    ...actual,
    readdir: through('readdir'),
    stat: through('stat'),
    readFile: through('readFile'),
  };
});

// 005 T007 — the token_count events of a Codex rollout (R2, contracts/sources.md).

const line = (rateLimits: unknown, usage: unknown = { input_tokens: 10, output_tokens: 5 }) =>
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage }, rate_limits: rateLimits },
  });

describe('lastRolloutSample', () => {
  it('reads the last token_count of the fixture, an unreadable line skipped', () => {
    expect(
      lastRolloutSample(readFileSync('tests/fixtures/usage/codex-rollout.jsonl', 'utf8')),
    ).toEqual({
      windows: [
        {
          id: 'five-hour',
          label: '5 h',
          usedPercent: 18,
          resetsAt: new Date(1793721600 * 1000).toISOString(),
          minutes: 300,
        },
        {
          id: 'week',
          label: 'semaine',
          usedPercent: 4,
          resetsAt: new Date(1794067200 * 1000).toISOString(),
          minutes: 10_080,
        },
      ],
      tokens: 12000 + 2500,
    });
  });

  it('names a window of another length in hours', () => {
    const text = line({ primary: { used_percent: 7, window_minutes: 120 } });
    expect(lastRolloutSample(text)?.windows).toEqual([
      { id: '120m', label: '2 h', usedPercent: 7, resetsAt: null, minutes: 120 },
    ]);
  });

  it('gives no limits when rate_limits is null, the tokens still', () => {
    expect(lastRolloutSample(line(null))).toEqual({ windows: null, tokens: 15 });
  });

  it('keeps the last limits when a later count has none', () => {
    const text = [
      line({ primary: { used_percent: 30, window_minutes: 300 } }),
      line(null, { input_tokens: 100, output_tokens: 1 }),
    ].join('\n');
    expect(lastRolloutSample(text)).toMatchObject({
      windows: [{ id: 'five-hour', usedPercent: 30 }],
      tokens: 101,
    });
  });

  it('is nothing without a token_count', () => {
    expect(lastRolloutSample('{"type":"session_meta","payload":{}}\n{coupée\n')).toBeNull();
    expect(lastRolloutSample('')).toBeNull();
  });

  it('has no window without minutes: it is named after its missing length', () => {
    const text = line({ primary: { used_percent: 7 } });
    expect(lastRolloutSample(text)?.windows).toEqual([
      { id: 'nullm', label: 'nullm', usedPercent: 7, resetsAt: null, minutes: null },
    ]);
  });

  it('ignores a window with a negative or non numeric used_percent', () => {
    const text = line({
      primary: { used_percent: -1, window_minutes: 300 },
      secondary: { used_percent: 'x', window_minutes: 300 },
    });
    expect(lastRolloutSample(text)).toEqual({ windows: null, tokens: 15 });
  });

  it('gives the limits with no tokens when info carries none', () => {
    const event = (info: unknown) =>
      JSON.stringify({
        payload: {
          type: 'token_count',
          info,
          rate_limits: { primary: { used_percent: 1, window_minutes: 300 } },
        },
      });
    for (const info of [null, {}, { total_token_usage: 3 }]) {
      expect(lastRolloutSample(event(info))).toMatchObject({
        windows: [{ id: 'five-hour' }],
        tokens: 0,
      });
    }
  });

  it('skips a line that is not an event', () => {
    expect(lastRolloutSample('[1]\n"texte"\n{"payload":3}\n')).toBeNull();
  });
});

describe('findRollout', () => {
  const entry = (name: string, dir: boolean) => ({
    name,
    isDirectory: () => dir,
    isFile: () => !dir,
  });
  const at = (...parts: string[]) => join('/codex', 'sessions', ...parts);
  const tree: Record<string, unknown[]> = {
    [at()]: [entry('2026', true), entry('notes.txt', false)],
    [at('2026')]: [entry('11', true), entry('10', true)],
    [at('2026', '11')]: [entry('05', true), entry('04', true)],
    [at('2026', '11', '05')]: [
      entry('rollout-a-autre.jsonl', false),
      entry('rollout-a-abc.json', false),
      entry('x-abc.jsonl', false),
    ],
    [at('2026', '11', '04')]: [],
    [at('2026', '10')]: [entry('30', true)],
    [at('2026', '10', '30')]: [entry('rollout-b-abc.jsonl', false)],
  };

  afterEach(() => {
    fsHooks.readdir = undefined;
  });

  it('goes on to older days when the latest ones lack the session, a stray file skipped', async () => {
    fsHooks.readdir = (dir) =>
      typeof dir === 'string' && dir in tree
        ? Promise.resolve(tree[dir])
        : Promise.reject(new Error('ENOENT'));
    expect(await findRollout('/codex', 'abc')).toBe(at('2026', '10', '30', 'rollout-b-abc.jsonl'));
    expect(await findRollout('/codex', 'inconnue')).toBeNull();
  });
});

describe('CodexRollout, driven call by call', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const sample = (percent: number) =>
    line({ primary: { used_percent: percent, window_minutes: 300 } });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const found = (name = 'rollout-x-abc.jsonl') => [
    [{ name: '2026', isDirectory: () => true, isFile: () => false }],
    [{ name: '11', isDirectory: () => true, isFile: () => false }],
    [{ name: '05', isDirectory: () => true, isFile: () => false }],
    [{ name, isDirectory: () => false, isFile: () => true }],
  ];
  const wire = (levels = found()) => {
    let depth = 0;
    fsHooks.readdir = vi.fn(() => Promise.resolve(levels[depth++] ?? []));
  };
  const make = (samples: UsageSample[], intervalMs?: number) =>
    new CodexRollout({
      codexHome: '/codex',
      sessionId: 'abc',
      onSample: (s) => samples.push(s),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });

  afterEach(() => {
    fsHooks.readdir = fsHooks.stat = fsHooks.readFile = undefined;
    vi.useRealTimers();
  });

  it('ignores a read asked while another one is reading, then reads again', async () => {
    wire();
    const gate = deferred<{ size: number }>();
    const stat = vi.fn(() => gate.promise);
    fsHooks.stat = stat;
    let percent = 10;
    fsHooks.readFile = () => Promise.resolve(sample(percent++));
    const samples: UsageSample[] = [];
    const watcher = make(samples);

    const first = watcher.read();
    await flush();
    expect(stat).toHaveBeenCalledTimes(1);
    await watcher.read(); // the first one is still waiting for stat: nothing starts
    expect(stat).toHaveBeenCalledTimes(1);

    gate.resolve({ size: 5 });
    await first;
    expect(samples).toHaveLength(1);

    fsHooks.stat = () => Promise.resolve({ size: 6 });
    await watcher.read(); // the guard was released
    expect(samples).toHaveLength(2);
  });

  it('releases the guard when the read fails, and reads again', async () => {
    wire();
    fsHooks.stat = () => Promise.reject(new Error('EBUSY'));
    const samples: UsageSample[] = [];
    const watcher = make(samples);
    await expect(watcher.read()).resolves.toBeUndefined();
    expect(samples).toEqual([]);

    fsHooks.stat = () => Promise.resolve({ size: 4 });
    fsHooks.readFile = () => Promise.resolve(sample(20));
    await watcher.read();
    expect(samples).toHaveLength(1);
  });

  it('does not read twice a file whose size has not changed', async () => {
    wire();
    fsHooks.stat = () => Promise.resolve({ size: 7 });
    const readFile = vi.fn(() => Promise.resolve(sample(30)));
    fsHooks.readFile = readFile;
    const samples: UsageSample[] = [];
    const watcher = make(samples);
    await watcher.read();
    await watcher.read();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(1);
  });

  it('ignores a sample identical to the previous one, whatever size stat shows', async () => {
    wire();
    let size = 3;
    fsHooks.stat = () => Promise.resolve({ size });
    fsHooks.readFile = () => Promise.resolve(sample(30));
    const samples: UsageSample[] = [];
    const watcher = make(samples);
    await watcher.read();
    size = 4; // an append seen half-way: the size moved, the last whole line did not
    await watcher.read();
    expect(samples).toHaveLength(1);

    size = 5;
    fsHooks.readFile = () => Promise.resolve(sample(31));
    await watcher.read();
    expect(samples).toHaveLength(2);
  });

  it('gives nothing when the rollout has no token_count, and keeps the size', async () => {
    wire();
    fsHooks.stat = () => Promise.resolve({ size: 2 });
    fsHooks.readFile = () => Promise.resolve('{"type":"session_meta","payload":{}}\n');
    const samples: UsageSample[] = [];
    await make(samples).read();
    expect(samples).toEqual([]);
  });

  it('gives nothing when stopped while the file is being read', async () => {
    wire();
    fsHooks.stat = () => Promise.resolve({ size: 9 });
    const gate = deferred<string>();
    fsHooks.readFile = () => gate.promise;
    const samples: UsageSample[] = [];
    const watcher = make(samples);

    const reading = watcher.read();
    await flush();
    watcher.stop();
    gate.resolve(sample(40));
    await reading;
    expect(samples).toEqual([]);
  });

  it('waits for the rollout of the session: nothing is read before Codex writes it', async () => {
    wire([[]]);
    const stat = vi.fn();
    fsHooks.stat = stat;
    await make([]).read();
    expect(stat).not.toHaveBeenCalled();
  });

  it('starts once and reads again at each interval, the default one included', async () => {
    vi.useFakeTimers();
    wire();
    let size = 1;
    fsHooks.stat = () => Promise.resolve({ size: size++ });
    fsHooks.readFile = () => Promise.resolve(sample(50 + size));
    const samples: UsageSample[] = [];
    const watcher = make(samples);

    watcher.start();
    watcher.start(); // already started: no second timer, no second read
    await vi.advanceTimersByTimeAsync(0);
    expect(samples).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(ROLLOUT_INTERVAL_MS);
    expect(samples).toHaveLength(2);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(ROLLOUT_INTERVAL_MS);
    expect(samples).toHaveLength(2);
  });

  it('reads at the interval it is given', async () => {
    vi.useFakeTimers();
    wire();
    let size = 1;
    fsHooks.stat = () => Promise.resolve({ size: size++ });
    fsHooks.readFile = () => Promise.resolve(sample(60 + size));
    const samples: UsageSample[] = [];
    const watcher = make(samples, 50);
    watcher.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(samples).toHaveLength(2);
    watcher.stop();
  });
});
