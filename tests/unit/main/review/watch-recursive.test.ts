import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { watchRecursive } from '../../../../src/main/review/review-service';

// #68 — `watchRecursive` filters what `fs.watch` reports. Whether the OS delivers the event of a
// rewritten `.git` file in time is not ours to decide, so the filter is driven by hand here
// instead of waiting for a real event (which made the branch coverage of the service vary).
type Listener = (event: string, file: string | Buffer | null) => void;
const fake = vi.hoisted(() => ({
  listener: undefined as Listener | undefined,
  closed: 0,
  throwOnWatch: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (_dir: string, _options: unknown, listener: Listener) => {
      if (fake.throwOnWatch) throw new Error('ENOENT');
      fake.listener = listener;
      return Object.assign(new EventEmitter(), {
        close: () => {
          fake.closed += 1;
        },
      });
    },
  };
});

const emit = (file: string | Buffer | null) => {
  fake.listener?.('change', file);
};

beforeEach(() => {
  fake.listener = undefined;
  fake.closed = 0;
  fake.throwOnWatch = false;
});

describe('watchRecursive', () => {
  it('reports the changes of the worktree, with / as separator', () => {
    const seen: (string | null)[] = [];
    watchRecursive('/wt', (name) => seen.push(name));
    emit('src/a.ts');
    emit('src\\b.ts');
    emit(Buffer.from('c.ts'));
    expect(seen).toEqual(['src/a.ts', 'src/b.ts', 'c.ts']);
  });

  it('reports an event with no file name, as null', () => {
    const seen: (string | null)[] = [];
    watchRecursive('/wt', (name) => seen.push(name));
    emit(null);
    expect(seen).toEqual([null]);
  });

  it('ignores the .git file and the .git folder of the worktree, on any separator', () => {
    const seen: (string | null)[] = [];
    watchRecursive('/wt', (name) => seen.push(name));
    emit('.git');
    emit('.git/index');
    emit('.git\\HEAD');
    emit('.github/ci.yml');
    expect(seen).toEqual(['.github/ci.yml']);
  });

  it('stops watching when asked, and survives a watcher error', () => {
    const stop = watchRecursive('/wt', () => undefined);
    stop();
    expect(fake.closed).toBe(1);
  });

  it('follows nothing, quietly, when the worktree cannot be watched', () => {
    fake.throwOnWatch = true;
    const stop = watchRecursive('/gone', () => undefined);
    expect(() => {
      stop();
    }).not.toThrow();
    expect(fake.closed).toBe(0);
  });
});
