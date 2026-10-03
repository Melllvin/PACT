import { describe, expect, it } from 'vitest';
import { parseNumstat, parseRaw } from '../../../../src/main/git/diff-output';

// 002 T008 — the machine-readable output of `git diff` (research R2), malformed input included.

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const zero = '0'.repeat(40);
const raw = (...parts: string[]) => `${parts.join('\0')}\0`;

describe('parseRaw', () => {
  it('reads each status, the new blob, and null for a deleted file', () => {
    expect(
      parseRaw(
        raw(
          `:100644 100644 ${a} ${b} M`,
          'm.txt',
          `:000000 100644 ${zero} ${b} A`,
          'a.txt',
          `:100644 000000 ${a} ${zero} D`,
          'd.txt',
          `:100644 120000 ${a} ${b} T`,
          't.txt',
        ),
      ),
    ).toEqual([
      { status: 'modified', path: 'm.txt', oldPath: null, blob: b },
      { status: 'added', path: 'a.txt', oldPath: null, blob: b },
      { status: 'deleted', path: 'd.txt', oldPath: null, blob: null },
      { status: 'modified', path: 't.txt', oldPath: null, blob: b },
    ]);
  });

  it('keeps the old path of a rename, and takes a copy for an added file', () => {
    expect(
      parseRaw(
        raw(
          `:100644 100644 ${a} ${b} R087`,
          'old.txt',
          'new.txt',
          `:100644 100644 ${a} ${b} C100`,
          'src.txt',
          'copy.txt',
        ),
      ),
    ).toEqual([
      { status: 'renamed', path: 'new.txt', oldPath: 'old.txt', blob: b },
      { status: 'added', path: 'copy.txt', oldPath: null, blob: b },
    ]);
  });

  it('takes an unknown status for a modification', () => {
    expect(parseRaw(raw(`:100644 100644 ${a} ${b} X`, 'x.txt'))).toEqual([
      { status: 'modified', path: 'x.txt', oldPath: null, blob: b },
    ]);
  });

  it('reads nothing from an empty diff, and survives a cut one', () => {
    expect(parseRaw('')).toEqual([]);
    expect(parseRaw(`:100644\0`)).toEqual([
      { status: 'modified', path: '', oldPath: null, blob: null },
    ]);
    expect(parseRaw(`:100644 100644 ${a} ${b} R050\0old.txt\0`)).toEqual([
      { status: 'renamed', path: '', oldPath: 'old.txt', blob: b },
    ]);
  });
});

describe('parseNumstat', () => {
  it('reads the lines added and removed per path, null for a binary file', () => {
    expect(parseNumstat(raw('3\t1\tm.txt', '-\t-\timage.png'))).toEqual(
      new Map([
        ['m.txt', { added: 3, removed: 1 }],
        ['image.png', { added: null, removed: null }],
      ]),
    );
  });

  it('files a rename under its new path', () => {
    expect(parseNumstat(raw('1\t0\t', 'old.txt', 'new.txt'))).toEqual(
      new Map([['new.txt', { added: 1, removed: 0 }]]),
    );
  });

  it('reads nothing from an empty diff, and survives a cut one', () => {
    expect(parseNumstat('')).toEqual(new Map());
    expect(parseNumstat('2\0')).toEqual(new Map([['', { added: 2, removed: 0 }]]));
    expect(parseNumstat('1\t0\t\0')).toEqual(new Map([['', { added: 1, removed: 0 }]]));
  });
});
