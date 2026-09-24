import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalRegistry,
  type TerminalLike,
} from '../../../../src/renderer/tiles/terminal-registry';
import type { IpcEvent, PactApi } from '../../../../src/shared/ipc';

// T068 — one xterm per terminal, fed by term:data, typing sent with term:write.

const fakeTerminal = () => {
  let input: (data: string) => void = () => undefined;
  const terminal = {
    cols: 80,
    rows: 24,
    written: [] as string[],
    openedIn: [] as HTMLElement[],
    element: undefined as HTMLElement | undefined,
    type: (data: string) => {
      input(data);
    },
    open: vi.fn((parent: HTMLElement) => {
      terminal.openedIn.push(parent);
      terminal.element = document.createElement('div');
      parent.appendChild(terminal.element);
    }),
    write: vi.fn((data: string) => terminal.written.push(data)),
    onData: (listener: (data: string) => void) => {
      input = listener;
      return { dispose: () => undefined };
    },
    fit: vi.fn(() => {
      terminal.cols = 120;
      terminal.rows = 40;
    }),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
  return terminal;
};

const setup = () => {
  let onData: (event: IpcEvent<'term:data'>) => void = () => undefined;
  const invoke = vi.fn(() => Promise.resolve(undefined));
  const api = {
    invoke,
    on: (_channel: string, listener: (event: IpcEvent<'term:data'>) => void) => {
      onData = listener;
      return () => undefined;
    },
  } as unknown as PactApi;
  const terminals: ReturnType<typeof fakeTerminal>[] = [];
  const registry = createTerminalRegistry(api, () => {
    const terminal = fakeTerminal();
    terminals.push(terminal);
    return terminal satisfies TerminalLike;
  });
  const emit = (e: IpcEvent<'term:data'>) => {
    onData(e);
  };
  return { registry, invoke, terminals, emit };
};

describe('terminal registry', () => {
  it('keeps the output that arrives before the terminal is shown', () => {
    const { registry, emit, terminals } = setup();
    emit({ termId: 't1', data: 'Session s1\r\n> ' });
    const element = document.createElement('div');
    registry.attach('t1', element);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.written).toEqual(['Session s1\r\n> ']);
    expect(terminals[0]?.openedIn).toEqual([element]);
  });

  it('sends what the user types to the right terminal', () => {
    const { registry, invoke, terminals } = setup();
    registry.attach('t1', document.createElement('div'));
    terminals[0]?.type('Ajoute un test\r');
    expect(invoke).toHaveBeenCalledWith('term:write', { termId: 't1', data: 'Ajoute un test\r' });
  });

  it('fits the terminal to its tile and reports the new size', () => {
    const { registry, invoke, terminals } = setup();
    registry.attach('t1', document.createElement('div'));
    expect(terminals[0]?.fit).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('term:resize', { termId: 't1', cols: 120, rows: 40 });
  });

  it('moves the same terminal, with its history, into a new tile', () => {
    const { registry, terminals } = setup();
    const first = document.createElement('div');
    const detach = registry.attach('t1', first);
    detach();
    const second = document.createElement('div');
    registry.attach('t1', second);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.open).toHaveBeenCalledOnce();
    expect(second.contains(terminals[0]?.element ?? null)).toBe(true);
  });

  it('frees a terminal that is gone', () => {
    const { registry, terminals } = setup();
    registry.attach('t1', document.createElement('div'));
    registry.dispose('t1');
    expect(terminals[0]?.dispose).toHaveBeenCalled();
    registry.dispose('unknown');
  });
});
