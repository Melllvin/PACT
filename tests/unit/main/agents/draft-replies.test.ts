import { describe, expect, it } from 'vitest';
import {
  applyTyped,
  EMPTY_DRAFT,
  skipTerminalReplies,
} from '../../../../src/main/agents/agent-state';

// 007 R5 — what xterm answers by itself to a query of the CLI or of ConPTY reaches `typed` like a
// key, and is none: it must not fill the prompt, or the wake would wait for ever (Windows CI).

describe('applyTyped with the replies of the terminal', () => {
  it.each([
    ['a cursor position', '\x1b[1;1R'],
    ['a cursor position with a page', '\x1b[?12;40;1R'],
    ['a focus in then out', '\x1b[I\x1b[O'],
    ['a device status', '\x1b[0n'],
    ['the primary attributes', '\x1b[?1;2c'],
    ['the secondary attributes', '\x1b[>0;276;0c'],
    ['a mode report', '\x1b[?2004;2$y'],
    ['a window size report', '\x1b[8;24;80t'],
    ['the kitty keyboard flags', '\x1b[?0u'],
    ['a color answer ended by BEL', '\x1b]11;rgb:0c0c/0c0c/0f0f\x07'],
    ['a color answer ended by ST', '\x1b]10;rgb:eded/eded/efef\x1b\\'],
    ['a string answer', '\x1bP1$r0m\x1b\\'],
  ])(
    'Given an empty prompt, When the terminal sends %s, Then the draft stays empty',
    (_, reply) => {
      expect(applyTyped(EMPTY_DRAFT, reply, 'awaiting-prompt')).toEqual(EMPTY_DRAFT);
    },
  );

  it('Given a reply between two keys, When they are typed, Then only the keys count', () => {
    const draft = applyTyped(EMPTY_DRAFT, 'a\x1b[3;7Rb', 'awaiting-prompt');
    expect(draft).toEqual({ count: 2, unknown: false, stuck: false });
  });

  it('Given a reply and then Enter, Then the draft is empty and nothing was left unknown', () => {
    expect(applyTyped(EMPTY_DRAFT, '\x1b[1;1R\r', 'awaiting-prompt')).toEqual(EMPTY_DRAFT);
  });

  it('Given a key that moves the cursor, Then the content is still unknown', () => {
    expect(applyTyped(EMPTY_DRAFT, '\x1b[D', 'awaiting-prompt').unknown).toBe(true);
    expect(applyTyped(EMPTY_DRAFT, '\x1b[1;5C', 'awaiting-prompt').unknown).toBe(true);
    expect(applyTyped(EMPTY_DRAFT, '\x1b[3~', 'awaiting-prompt').unknown).toBe(true);
  });

  it('Given a paste that holds a reply-like text, Then the paste is skipped whole and unknown', () => {
    const draft = applyTyped(EMPTY_DRAFT, '\x1b[200~\x1b[1;1R\x1b[201~', 'awaiting-prompt');
    expect(draft).toMatchObject({ unknown: true, count: 0 });
  });
});

describe('skipTerminalReplies', () => {
  it('Given plain text, Then it is returned untouched', () => {
    expect(skipTerminalReplies('Écris la fonction\r')).toBe('Écris la fonction\r');
  });
});
