import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexRollout,
  findRollout,
  ROLLOUT_INTERVAL_MS,
} from '../../../src/main/usage/codex-rollout';
import type { UsageSample } from '../../../src/main/usage/sample';

// `stat` can be told to lie once, to play what Windows does while Codex is appending.
const realStat = vi.hoisted(() => ({
  fn: undefined as undefined | ((p: string) => Promise<unknown>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realStat.fn = actual.stat;
  return { ...actual, stat: vi.fn(actual.stat) };
});

// 005 T009 — the rollout of a Codex session, found by its id under CODEX_HOME and followed, read
// only (R2).

let home: string;
let rollout: CodexRollout | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pact-codex-home-'));
});

afterEach(async () => {
  rollout?.stop();
  rollout = undefined;
  await rm(home, { recursive: true, force: true });
});

const count = (percent: number) =>
  `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: percent * 10, output_tokens: 0 } },
      rate_limits: { primary: { used_percent: percent, window_minutes: 300 } },
    },
  })}\n`;

async function session(day: string, id: string) {
  const dir = join(home, 'sessions', ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-${day}T10-00-00-${id}.jsonl`);
  await writeFile(file, '{"type":"session_meta","payload":{}}\n');
  return file;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('CodexRollout', () => {
  it('finds the rollout of the session among others', async () => {
    await session('2026-11-02', 'autre');
    const file = await session('2026-11-03', 'abc');
    expect(await findRollout(home, 'abc')).toBe(file);
    expect(await findRollout(home, 'absente')).toBeNull();
    expect(await findRollout(join(home, 'rien'), 'abc')).toBeNull();
  });

  it('follows what Codex appends, read only, and stops', async () => {
    const samples: UsageSample[] = [];
    rollout = new CodexRollout({
      codexHome: home,
      sessionId: 'abc',
      onSample: (s) => samples.push(s),
      intervalMs: 20,
    });
    rollout.start();
    // Codex has not written it yet: nothing, and no error.
    await new Promise((r) => setTimeout(r, 60));
    expect(samples).toEqual([]);

    const file = await session('2026-11-03', 'abc');
    const before = (await stat(file)).mode;
    await appendFile(file, count(12));
    await until(() => samples.length === 1);
    expect(samples[0]?.windows?.[0]?.usedPercent).toBe(12);

    await appendFile(file, count(40));
    await until(() => samples.length === 2);
    expect(samples[1]).toMatchObject({ tokens: 400, windows: [{ usedPercent: 40 }] });

    // Nothing new: nothing sent again.
    await new Promise((r) => setTimeout(r, 60));
    expect(samples).toHaveLength(2);

    rollout.stop();
    await appendFile(file, count(60));
    await new Promise((r) => setTimeout(r, 60));
    expect(samples).toHaveLength(2);
    expect((await stat(file)).mode).toBe(before);
    expect(await readdir(join(home, 'sessions', '2026', '11', '03'))).toHaveLength(1);
  });

  it('sends nothing again when stat shows an intermediate size of an append (Windows)', async () => {
    const samples: UsageSample[] = [];
    const file = await session('2026-11-03', 'abc');
    await appendFile(file, count(12));
    rollout = new CodexRollout({
      codexHome: home,
      sessionId: 'abc',
      onSample: (s) => samples.push(s),
      intervalMs: 20,
    });
    rollout.start();
    await until(() => samples.length === 1);

    // Codex appends a line; stat sees the file mid-write (a size no whole line ends at), then whole.
    const { stat: mocked } = await import('node:fs/promises');
    vi.mocked(mocked).mockImplementationOnce((async (path: string) => {
      const real = (await realStat.fn?.(path)) as { size: number };
      return { ...real, size: real.size + 17 };
    }) as never);
    await appendFile(file, count(40));
    await until(() => samples.length === 2);
    await new Promise((r) => setTimeout(r, 100));

    expect(samples.map((s) => s.windows?.[0]?.usedPercent)).toEqual([12, 40]);
  });

  it('reads at most every 10 s by default', () => {
    expect(ROLLOUT_INTERVAL_MS).toBe(10_000);
  });
});
