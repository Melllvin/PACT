import { beforeEach, describe, expect, it, vi } from 'vitest';

// fix-relance-communs — Shift+Enter in a terminal: xterm sends `\r` for it as for Enter, so the
// prompt left instead of a line break. The key handler of the factory is tested with a fake
// xterm: what it lets xterm do, and what it sends to the PTY (the listeners of `onData`).

type KeyHandler = (event: KeyboardEvent) => boolean;

const state = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: KeyboardEvent) => boolean),
  listeners: [] as ((data: string) => void)[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element = undefined;
    unicode = { activeVersion: '6' };
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    attachCustomKeyEventHandler(handler: KeyHandler) {
      state.handler = handler;
    }
    onData(listener: (data: string) => void) {
      state.listeners.push(listener);
      return { dispose: vi.fn() };
    }
    // Both ways a handler can feed the PTY through xterm come out of `onData`.
    input(data: string) {
      for (const listener of state.listeners) listener(data);
    }
    paste(data: string) {
      for (const listener of state.listeners) listener(data);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn() }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn() }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { createXterm } from '../../../../src/renderer/tiles/xterm-factory';

/**
 * Checked on the real CLIs installed (Claude Code 2.1.318): ESC+CR, `\n`, `\` + CR and
 * `ESC[13;2u` all insert a line break without submitting, where `\r` submits. A single one goes.
 */
const LINE_BREAKS = ['\x1b\r', '\n', '\\\r', '\x1b[13;2u'];

/**
 * What a key press does: the data the handler sends itself (through `onData`), and whether it lets
 * xterm act on each event (xterm turns an Enter it handles into `\r`, with or without Shift).
 */
const run = (init: KeyboardEventInit) => {
  const fromHandler: string[] = [];
  state.listeners.push((data) => fromHandler.push(data));
  const letXtermAct = (['keydown', 'keypress', 'keyup'] as const).map((type) => {
    const event = new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      cancelable: true,
      ...init,
    });
    return state.handler?.(event) ?? true;
  });
  return { fromHandler, letXtermAct };
};

describe('createXterm key handler', () => {
  beforeEach(() => {
    state.handler = undefined;
    state.listeners = [];
    createXterm();
  });

  it('has a key handler', () => {
    expect(state.handler).toBeTypeOf('function');
  });

  it('sends one line-break sequence for Shift+Enter, and no `\\r` in addition', () => {
    const { fromHandler, letXtermAct } = run({ shiftKey: true });
    expect(fromHandler).toHaveLength(1);
    expect(fromHandler[0]).not.toBe('\r');
    expect(LINE_BREAKS).toContain(fromHandler[0]);
    // xterm must not add its own `\r` for any of the events of the press.
    expect(letXtermAct).toEqual([false, false, false]);
  });

  it('keeps Entrée alone as it is: the handler sends nothing, xterm sends `\\r`', () => {
    const { fromHandler, letXtermAct } = run({ shiftKey: false });
    expect(fromHandler).toEqual([]);
    expect(letXtermAct[0]).toBe(true);
  });

  it('does not touch Shift+Enter with another modifier, nor other keys with Shift', () => {
    for (const init of [
      { shiftKey: true, ctrlKey: true },
      { shiftKey: true, altKey: true },
      { shiftKey: true, key: 'a', code: 'KeyA' },
    ]) {
      const { fromHandler, letXtermAct } = run(init);
      expect(fromHandler).toEqual([]);
      expect(letXtermAct[0]).toBe(true);
    }
  });
});
