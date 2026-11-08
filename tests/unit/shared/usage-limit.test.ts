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
