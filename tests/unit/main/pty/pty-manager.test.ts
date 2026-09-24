import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PtyManager,
  type PtyProcess,
  type PtySpawnOptions,
} from '../../../../src/main/pty/pty-manager';

// Deterministic tests of batching, buffering and lifecycle with a scripted pseudo-terminal.
class FakePty implements PtyProcess {
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((e: { exitCode: number }) => void)[] = [];
  constructor(
    readonly file: string,
    readonly args: string[] | string,
    readonly options: PtySpawnOptions,
  ) {
    this.size = { cols: options.cols, rows: options.rows };
  }
  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose: () => undefined };
  }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows };
  }
  kill() {
    this.killed = true;
    this.exit(0);
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number) {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

let ptys: FakePty[];
let manager: PtyManager;
const spec = { file: '/bin/fake', args: ['--x'], env: { A: '1' }, cwd: '/repo' };
const pty = () => {
  const last = ptys.at(-1);
  if (!last) throw new Error('no pty');
  return last;
};

beforeEach(() => {
  vi.useFakeTimers();
  ptys = [];
  manager = new PtyManager({
    spawn: (file, args, options) => {
      const created = new FakePty(file, args, options);
      ptys.push(created);
      return created;
    },
    platform: 'darwin',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PtyManager', () => {
  it('spawns with the given command, environment, directory and a default size', () => {
    manager.start('a1', spec);
    expect(pty().file).toBe('/bin/fake');
    expect(pty().args).toEqual(['--x']);
    expect(pty().options).toMatchObject({ cwd: '/repo', env: { A: '1' }, cols: 80, rows: 24 });
  });

  it('refuses a second terminal with the same id', () => {
    manager.start('a1', spec);
    expect(() => {
      manager.start('a1', spec);
    }).toThrow();
  });

  it('passes pre-escaped arguments verbatim on Windows (cmd.exe wrapper)', () => {
    const windows = new PtyManager({
      spawn: (file, args, options) => {
        const created = new FakePty(file, args, options);
        ptys.push(created);
        return created;
      },
      platform: 'win32',
    });
    windows.start('w', {
      ...spec,
      args: ['/d', '/s', '/c', '"x ^"y^""'],
      windowsVerbatimArguments: true,
    });
    expect(pty().args).toBe('/d /s /c "x ^"y^""');
    windows.start('w2', { ...spec, args: ['a b'] });
    expect(pty().args).toEqual(['a b']);
  });

  it('batches output per frame (~16 ms) instead of one event per chunk', () => {
    const received: string[] = [];
    manager.onData((id, data) => received.push(`${id}:${data}`));
    manager.start('a1', spec);
    for (let i = 0; i < 100; i++) pty().emit(`${String(i)} `);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(
      `a1:${Array.from({ length: 100 }, (_, i) => `${String(i)} `).join('')}`,
    );
  });

  it('flushes pending output before reporting the exit', () => {
    const events: string[] = [];
    manager.onData((_id, data) => events.push(`data:${data}`));
    manager.onExit((_id, code) => events.push(`exit:${String(code)}`));
    manager.start('a1', spec);
    pty().emit('last words');
    pty().exit(3);
    expect(events).toEqual(['data:last words', 'exit:3']);
    expect(manager.has('a1')).toBe(false);
  });

  it('keeps about 1 MB of history per terminal, dropping the oldest output', () => {
    manager.start('a1', spec);
    pty().emit('OLDEST');
    pty().emit('x'.repeat(1_200_000));
    pty().emit('NEWEST');
    const history = manager.history('a1');
    expect(history.length).toBeLessThanOrEqual(1_000_000);
    expect(history.endsWith('NEWEST')).toBe(true);
    expect(history).not.toContain('OLDEST');
  });

  it('keeps the history readable after the process exited', () => {
    manager.start('a1', spec);
    pty().emit('bye');
    pty().exit(0);
    expect(manager.history('a1')).toBe('bye');
  });

  it('writes and resizes the right terminal', () => {
    manager.start('a1', spec);
    manager.start('a2', spec);
    manager.write('a1', 'ls\r');
    manager.resize('a1', 120, 40);
    expect(ptys[0]?.written).toEqual(['ls\r']);
    expect(ptys[0]?.size).toEqual({ cols: 120, rows: 40 });
    expect(ptys[1]?.written).toEqual([]);
  });

  it('ignores writes and resizes to unknown or exited terminals', () => {
    expect(() => {
      manager.write('nope', 'x');
      manager.resize('nope', 10, 10);
    }).not.toThrow();
  });

  it('kills a terminal and resolves once it has exited', async () => {
    const exits: number[] = [];
    manager.onExit((_id, code) => exits.push(code));
    manager.start('a1', spec);
    await manager.kill('a1');
    expect(pty().killed).toBe(true);
    expect(exits).toEqual([0]);
    expect(manager.has('a1')).toBe(false);
  });

  it('disposes every running terminal', async () => {
    manager.start('a1', spec);
    manager.start('a2', spec);
    await manager.dispose();
    expect(ptys.every((p) => p.killed)).toBe(true);
  });

  it('lets listeners unsubscribe', () => {
    const received: string[] = [];
    const off = manager.onData((_id, data) => received.push(data));
    manager.start('a1', spec);
    off();
    pty().emit('x');
    vi.advanceTimersByTime(16);
    expect(received).toEqual([]);
  });
});
