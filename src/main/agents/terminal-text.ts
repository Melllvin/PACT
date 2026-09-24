// Terminal output as text for CliAdapter.mapOutput. TUIs place words with cursor moves (raw Codex
// capture, T049), and a PTY chunk may cut a phrase in two.

const TAIL_CHARS = 500;

/* eslint-disable no-control-regex -- terminal escape sequences are the point here */
const CURSOR_MOVE = /\x1b\[[0-9;]*[CGHf]/g;
const OTHER_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESCAPE = /\x1b[@-_]/g;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

export const toPlainText = (chunk: string) =>
  chunk
    .replace(OSC, '')
    .replace(CURSOR_MOVE, ' ')
    .replace(OTHER_CSI, '')
    .replace(OTHER_ESCAPE, '')
    .replace(CONTROL, '');

/** Plain text of an agent's recent output: a short tail of what came before, plus the new chunk. */
export class TerminalText {
  private tail = '';

  push(chunk: string): string {
    const text = this.tail + toPlainText(chunk);
    this.tail = text.slice(-TAIL_CHARS);
    return text;
  }

  /** The recent output, as the last `push` returned it. */
  text(): string {
    return this.tail;
  }

  /** Forgets the output an adapter just recognized, so the same dialog is not reported again. */
  consume(): void {
    this.tail = '';
  }
}
