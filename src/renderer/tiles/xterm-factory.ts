import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalLike } from './terminal-registry';

/**
 * The DOM renderer by default: its text stays in the page, where the e2e suite and assistive
 * technologies read it. WebGL (research.md R2) is opt-in, and falls back to the DOM renderer.
 */
export function createXterm({ webgl = false } = {}): TerminalLike {
  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#dfe4eb' },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  terminal.loadAddon(new WebLinksAddon());

  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    get element() {
      return terminal.element;
    },
    open(parent) {
      terminal.open(parent);
      if (!webgl) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
        });
        terminal.loadAddon(addon);
      } catch {
        // No WebGL context: the DOM renderer stays.
      }
    },
    write(data) {
      terminal.write(data);
    },
    onData(listener) {
      return terminal.onData(listener);
    },
    fit() {
      // Hidden tiles have no size: fitting them would shrink the PTY to nothing.
      if (fit.proposeDimensions()) fit.fit();
    },
    focus() {
      terminal.focus();
    },
    dispose() {
      terminal.dispose();
    },
  };
}
