import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STOP,
  SAVE_BAND,
  limitBands,
  stopOf,
  usageLimitStateSchema,
  usagePauseSchema,
  usageStopsSchema,
  windowsOf,
} from '../../../src/shared/usage-limit';
import type { UsageReading, UsageState, UsageWindow } from '../../../src/shared/usage';

// 009 T003 — the shared rules of the stop at a limit: the threshold of each window, the band it is in
// (data-model.md « Seuil de fenêtre », « Bande d'une fenêtre », « Pause »; research R2, R3).

const now = new Date('2026-11-08T10:00:00.000Z');
const later = '2026-11-08T14:00:00.000Z';
const earlier = '2026-11-08T09:00:00.000Z';

const window = (id: string, usedPercent: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  id,
  label: id === 'five-hour' ? '5 h' : id === 'week' ? 'semaine' : id,
  usedPercent,
  resetsAt: later,
  minutes: null,
  ...over,
});
const reading = (...windows: UsageWindow[]): UsageReading => ({
  cliId: 'claude-code',
  account: 'default',
  windows,
  readAt: now.toISOString(),
});
const bandsOf = (r: UsageReading, stops = {}) =>
  Object.fromEntries(
    limitBands(r, usageStopsSchema.parse(stops), now).map((b) => [b.window.id, b.band]),
  );

describe('the constants', () => {
  it('stop at 90 %, save 3 points before', () => {
    expect([DEFAULT_STOP, SAVE_BAND]).toEqual([90, 3]);
  });
});

describe('usageStopsSchema', () => {
  it('is empty by default', () => {
    expect(usageStopsSchema.parse(undefined)).toEqual({});
  });

  it('keeps a threshold per CLI and per window, from 10 to 100 (FR-001, Q6)', () => {
    const stops = { 'claude-code': { 'five-hour': 10, week: 100 }, codex: { primary: 55 } };
    expect(usageStopsSchema.parse(stops)).toEqual(stops);
  });

  it.each([9, 101, 0, -5, 90.5, '90'])('refuses the threshold %j', (value) => {
    expect(usageStopsSchema.safeParse({ 'claude-code': { week: value } }).success).toBe(false);
  });

  it('refuses an empty CLI or window id', () => {
    expect(usageStopsSchema.safeParse({ '': { week: 90 } }).success).toBe(false);
    expect(usageStopsSchema.safeParse({ 'claude-code': { '': 90 } }).success).toBe(false);
  });
});

describe('stopOf', () => {
  it('gives 90 for a window that has no threshold of its own', () => {
    expect(stopOf({}, 'claude-code', 'week')).toBe(90);
    expect(stopOf({ codex: { primary: 80 } }, 'claude-code', 'week')).toBe(90);
    expect(stopOf({ 'claude-code': { 'five-hour': 80 } }, 'claude-code', 'week')).toBe(90);
  });

  it('gives the threshold set for the window of that CLI', () => {
    expect(stopOf({ 'claude-code': { week: 80 } }, 'claude-code', 'week')).toBe(80);
  });
});

describe('limitBands', () => {
  it('classes a window ok under the band, save from threshold − 3, stop from the threshold (R3)', () => {
    expect(bandsOf(reading(window('five-hour', 86.9)))).toEqual({ 'five-hour': 'ok' });
    expect(bandsOf(reading(window('five-hour', 87)))).toEqual({ 'five-hour': 'save' });
    expect(bandsOf(reading(window('five-hour', 89.9)))).toEqual({ 'five-hour': 'save' });
    expect(bandsOf(reading(window('five-hour', 90)))).toEqual({ 'five-hour': 'stop' });
    expect(bandsOf(reading(window('five-hour', 104)))).toEqual({ 'five-hour': 'stop' });
  });

  it('classes every window by itself: the busiest one is not enough (FR-002)', () => {
    const bands = bandsOf(
      reading(window('five-hour', 95), window('week', 88), window('seven_day_opus', 40)),
    );
    expect(bands).toEqual({ 'five-hour': 'stop', week: 'save', seven_day_opus: 'ok' });
  });

  it('reads the threshold of each window, the windows per model included (Q4)', () => {
    const stops = { 'claude-code': { week: 80, seven_day_opus: 50 } };
    const r = reading(window('five-hour', 85), window('week', 80), window('seven_day_opus', 47));
    expect(bandsOf(r, stops)).toEqual({ 'five-hour': 'ok', week: 'stop', seven_day_opus: 'save' });
  });

  it('gives the window, its threshold and its band', () => {
    const [band] = limitBands(reading(window('week', 88)), { 'claude-code': { week: 90 } }, now);
    expect(band).toMatchObject({ window: { id: 'week', reset: false }, stop: 90, band: 'save' });
  });

  it('classes ok a window whose reset has passed, whatever its last percentage (FR-002)', () => {
    const r = reading(window('five-hour', 99, { resetsAt: earlier }), window('week', 91));
    expect(bandsOf(r)).toEqual({ 'five-hour': 'ok', week: 'stop' });
    const [first] = limitBands(r, {}, now);
    expect(first?.window).toMatchObject({ id: 'five-hour', reset: true, usedPercent: 0 });
  });

  it('starts the band at 7 for a threshold of 10, and at 97 for a threshold of 100', () => {
    const low = { 'claude-code': { week: 10 } };
    expect(bandsOf(reading(window('week', 6.9)), low)).toEqual({ week: 'ok' });
    expect(bandsOf(reading(window('week', 7)), low)).toEqual({ week: 'save' });
    expect(bandsOf(reading(window('week', 10)), low)).toEqual({ week: 'stop' });
    const high = { 'claude-code': { week: 100 } };
    expect(bandsOf(reading(window('week', 96.9)), high)).toEqual({ week: 'ok' });
    expect(bandsOf(reading(window('week', 97)), high)).toEqual({ week: 'save' });
    expect(bandsOf(reading(window('week', 99.9)), high)).toEqual({ week: 'save' });
    expect(bandsOf(reading(window('week', 100)), high)).toEqual({ week: 'stop' });
  });
});

describe('windowsOf', () => {
  const ids = (cliId: string, states: UsageState[]) => windowsOf(cliId, states).map((w) => w.id);
  const state = (cliId: string, ...windows: UsageWindow[]): UsageState => ({
    cliId,
    account: 'default',
    reading: { cliId, account: 'default', windows, readAt: now.toISOString() },
    shares: [],
    level: 'ok',
  });

  it('gives the 5 h and the week of Claude Code before any reading (R2)', () => {
    expect(ids('claude-code', [])).toEqual(['five-hour', 'week']);
  });

  it('adds the windows per model a reading shows, once each', () => {
    const states = [
      state(
        'claude-code',
        window('five-hour', 10),
        window('week', 10),
        window('seven_day_opus', 5),
      ),
      state('claude-code', window('seven_day_opus', 9)),
    ];
    expect(ids('claude-code', states).sort()).toEqual(['five-hour', 'seven_day_opus', 'week']);
  });

  it('gives only the windows read for another CLI, and none before a reading', () => {
    expect(ids('codex', [])).toEqual([]);
    const states = [state('codex', window('primary', 10)), state('claude-code', window('week', 1))];
    expect(ids('codex', states)).toEqual(['primary']);
  });
});

describe('usagePauseSchema', () => {
  const pause = (over: Record<string, unknown> = {}) => ({
    cliId: 'claude-code',
    account: 'default',
    cause: 'threshold',
    windows: [{ id: 'five-hour', label: '5 h', percent: 91, resetsAt: later }],
    resumeAt: later,
    pausedAt: now.toISOString(),
    midTurn: true,
    saved: false,
    closedQuestion: null,
    blocked: null,
    ...over,
  });

  it('accepts a pause with its windows, its resume time and its constat de sauvegarde', () => {
    expect(usagePauseSchema.safeParse(pause()).success).toBe(true);
    expect(usagePauseSchema.safeParse(pause({ cause: 'stale', resumeAt: null })).success).toBe(
      true,
    );
  });

  it('refuses a pause with no window (.min(1))', () => {
    expect(usagePauseSchema.safeParse(pause({ windows: [] })).success).toBe(false);
  });

  it('keeps the closed question to 200 characters, or null (.max(200).nullable())', () => {
    expect(usagePauseSchema.safeParse(pause({ closedQuestion: 'q'.repeat(200) })).success).toBe(
      true,
    );
    expect(usagePauseSchema.safeParse(pause({ closedQuestion: 'q'.repeat(201) })).success).toBe(
      false,
    );
  });

  it("knows one reason to wait for a gesture: the session (z.enum(['session']).nullable())", () => {
    expect(usagePauseSchema.safeParse(pause({ blocked: 'session' })).success).toBe(true);
    expect(usagePauseSchema.safeParse(pause({ blocked: 'other' })).success).toBe(false);
  });

  it('refuses an unknown cause', () => {
    expect(usagePauseSchema.safeParse(pause({ cause: 'manual' })).success).toBe(false);
  });
});

describe('usageLimitStateSchema', () => {
  it('is empty by default', () => {
    const empty = { saves: [], overrides: [], declined: [], resumed: [] };
    expect(usageLimitStateSchema.parse(undefined)).toEqual(empty);
    expect(usageLimitStateSchema.parse({})).toEqual(empty);
  });
});

// 009 T036 — US3: a reading too old to be trusted (research R11, data-model « Proposition d'arrêt par
// prudence », spec US3 sc.1 and 4). `staleProposal(state, stops, workingCount, now)` is pure and rates
// `{ step, windows } | null`:
//   - `windows` names the windows within 10 points of their threshold or less (each with `id`, `label`,
//     `percent` as `pause.windows` has them, `resetsAt` too), as `currentWindow` reads them at `now`;
//   - `step` is `floor(age in minutes / 15)`, the age being the one `readingAge` gives (whole minutes).
// The function is loaded by its path, so each test fails on its own while it is absent.
describe('staleProposal (US3)', () => {
  type Proposal = {
    step: number;
    windows: { id: string; label: string; percent: number; resetsAt: string | null }[];
  };
  type StaleProposal = (
    state: UsageState,
    stops: Record<string, Record<string, number>>,
    workingCount: number,
    now: Date,
  ) => Proposal | null;

  const staleModule = '../../../src/shared/usage-limit';
  const propose = async (...args: Parameters<StaleProposal>) => {
    const rule = (
      (await import(/* @vite-ignore */ staleModule)) as { staleProposal?: StaleProposal }
    ).staleProposal;
    if (!rule) throw new Error('staleProposal is not exported by src/shared/usage-limit.ts');
    return rule(...args);
  };

  /** The state of an account whose reading is `minutes` old at `now` (10:00). */
  const aged = (minutes: number, ...windows: UsageWindow[]): UsageState => ({
    cliId: 'claude-code',
    account: 'default',
    reading: {
      cliId: 'claude-code',
      account: 'default',
      windows,
      readAt: new Date(now.getTime() - minutes * 60_000).toISOString(),
    },
    shares: [],
    level: 'ok',
  });
  const ids = (proposal: Proposal | null) => proposal?.windows.map((w) => w.id);

  it('is true for a reading older than 15 minutes, a working agent and a window 10 points from the threshold (US3 sc.1)', async () => {
    const proposal = await propose(aged(16, window('five-hour', 82)), {}, 1, now);
    expect(proposal).toMatchObject({
      step: 1,
      windows: [{ id: 'five-hour', label: '5 h', percent: 82, resetsAt: later }],
    });
  });

  it('is false without any working agent, however old the reading is (US3 sc.4)', async () => {
    expect(await propose(aged(16, window('five-hour', 85)), {}, 0, now)).toBeNull();
    expect(await propose(aged(240, window('five-hour', 85)), {}, 0, now)).toBeNull();
  });

  it('is false at 15 minutes and at 14 minutes: the reading must be older than 15', async () => {
    expect(await propose(aged(14, window('five-hour', 85)), {}, 1, now)).toBeNull();
    expect(await propose(aged(15, window('five-hour', 85)), {}, 1, now)).toBeNull();
    expect(await propose(aged(16, window('five-hour', 85)), {}, 1, now)).not.toBeNull();
  });

  it('is true at 10 points from the threshold and false at 11 (FR-009)', async () => {
    expect(await propose(aged(20, window('five-hour', 80)), {}, 1, now)).not.toBeNull();
    expect(await propose(aged(20, window('five-hour', 79)), {}, 1, now)).toBeNull();
    expect(await propose(aged(20, window('five-hour', 0)), {}, 1, now)).toBeNull();
  });

  it('counts the 10 points from the threshold of the window, not from 90 %', async () => {
    const stops = { 'claude-code': { week: 70, 'five-hour': 100 } };
    // The week is 10 points from 70; the 5 h window is 18 from 100.
    expect(
      ids(await propose(aged(20, window('week', 60), window('five-hour', 82)), stops, 1, now)),
    ).toEqual(['week']);
    expect(await propose(aged(20, window('five-hour', 89)), stops, 1, now)).toBeNull();
    expect(await propose(aged(20, window('five-hour', 90)), stops, 1, now)).not.toBeNull();
  });

  it('names every window near its threshold, and only those', async () => {
    const proposal = await propose(
      aged(20, window('five-hour', 85), window('week', 88), window('seven_day_opus', 30)),
      {},
      2,
      now,
    );
    expect(ids(proposal)?.sort()).toEqual(['five-hour', 'week']);
  });

  it('reads a window reset since its reading as 0 %: it is not near anything', async () => {
    const reset = window('five-hour', 88, { resetsAt: earlier });
    expect(await propose(aged(20, reset), {}, 1, now)).toBeNull();
    // Another window still near its threshold keeps the proposal alive, the reset one is not named.
    expect(ids(await propose(aged(20, reset, window('week', 85)), {}, 1, now))).toEqual(['week']);
  });

  it('is false for an account with no reading', async () => {
    const empty: UsageState = { ...aged(20), reading: null };
    expect(await propose(empty, {}, 3, now)).toBeNull();
  });

  it.each([
    [16, 1],
    [29, 1],
    [30, 2],
    [44, 2],
    [45, 3],
    [90, 6],
  ])('is at step floor(%i / 15) = %i', async (minutes, step) => {
    expect((await propose(aged(minutes, window('five-hour', 85)), {}, 1, now))?.step).toBe(step);
  });

  it('does not depend on the number of working agents beyond one', async () => {
    const state = aged(20, window('five-hour', 85));
    expect(await propose(state, {}, 1, now)).toEqual(await propose(state, {}, 7, now));
  });

  it('is judged at the `now` it is given', async () => {
    const state = aged(10, window('five-hour', 85));
    expect(await propose(state, {}, 1, now)).toBeNull();
    expect((await propose(state, {}, 1, new Date(now.getTime() + 6 * 60_000)))?.step).toBe(1);
  });
});
