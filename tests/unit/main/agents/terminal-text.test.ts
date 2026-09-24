import { describe, expect, it } from 'vitest';
import { TerminalText, toPlainText } from '../../../../src/main/agents/terminal-text';

// Real TUIs place each word with cursor moves (raw Codex capture from T049): adapters match text.

describe('toPlainText', () => {
  it('turns cursor moves between words into spaces', () => {
    const raw = '\x1b[6;3H\x1b[22mTrust\x1b[6;9Hthis\x1b[6;14Hfolder?\x1b[6;22HCodex\x1b[6;28Hcan';
    expect(toPlainText(raw)).toBe(' Trust this folder? Codex can');
  });

  it('turns cursor-forward moves into spaces and drops colors and titles', () => {
    expect(toPlainText('\x1b[1mDo\x1b[1Cyou\x1b[1Ctrust\x1b[0m\x1b]0;claude\x07?')).toBe(
      'Do you trust?',
    );
  });

  it('keeps line breaks and removes other control characters', () => {
    expect(toPlainText('a\r\nb\x1b[?25l\x1b[2Kc\x07')).toBe('a\nbc');
  });
});

describe('TerminalText', () => {
  it('finds a phrase split across two chunks', () => {
    const text = new TerminalText();
    expect(text.push('Hooks need')).toBe('Hooks need');
    expect(text.push('\x1b[1C review')).toBe('Hooks need  review');
  });

  it('forgets what was already matched, so a dialog is reported once', () => {
    const text = new TerminalText();
    text.push('Trust this folder?');
    text.consume();
    expect(text.push('› ')).toBe('› ');
  });

  it('keeps only a short tail of the previous output', () => {
    const text = new TerminalText();
    text.push('x'.repeat(5000));
    expect(text.push('y').length).toBeLessThanOrEqual(501);
  });
});
