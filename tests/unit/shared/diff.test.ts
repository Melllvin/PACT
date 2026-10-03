import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../../src/shared/diff';

// 002 T007 — the output of `git diff` for one file, turned into hunks (research R2).

const diff = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('parseUnifiedDiff', () => {
  it('numbers the lines of several hunks on both sides', () => {
    const hunks = parseUnifiedDiff(
      diff(
        'diff --git a/a.ts b/a.ts',
        'index 1111111..2222222 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@ export function a() {',
        ' un',
        '-deux',
        '+DEUX',
        ' trois',
        '@@ -10,2 +10,3 @@',
        ' dix',
        '+dix et demi',
        ' onze',
      ),
    );
    expect(hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: 'context', oldNo: 1, newNo: 1, text: 'un' },
          { kind: 'del', oldNo: 2, newNo: null, text: 'deux' },
          { kind: 'add', oldNo: null, newNo: 2, text: 'DEUX' },
          { kind: 'context', oldNo: 3, newNo: 3, text: 'trois' },
        ],
      },
      {
        oldStart: 10,
        newStart: 10,
        lines: [
          { kind: 'context', oldNo: 10, newNo: 10, text: 'dix' },
          { kind: 'add', oldNo: null, newNo: 11, text: 'dix et demi' },
          { kind: 'context', oldNo: 11, newNo: 12, text: 'onze' },
        ],
      },
    ]);
  });

  it('drops « \\ No newline at end of file »', () => {
    const [hunk] = parseUnifiedDiff(
      diff(
        '@@ -1 +1 @@',
        '-a',
        '\\ No newline at end of file',
        '+b',
        '\\ No newline at end of file',
      ),
    );
    expect(hunk?.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'a' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'b' },
    ]);
  });

  it('reads an added file', () => {
    const hunks = parseUnifiedDiff(
      diff(
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
      ),
    );
    expect(hunks).toEqual([
      {
        oldStart: 0,
        newStart: 1,
        lines: [
          { kind: 'add', oldNo: null, newNo: 1, text: 'a' },
          { kind: 'add', oldNo: null, newNo: 2, text: 'b' },
        ],
      },
    ]);
  });

  it('reads a deleted file', () => {
    const [hunk] = parseUnifiedDiff(
      diff(
        'deleted file mode 100644',
        '--- a/g.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-a',
        '-b',
      ),
    );
    expect(hunk).toMatchObject({ oldStart: 1, newStart: 0 });
    expect(hunk?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['del', 1, null],
      ['del', 2, null],
    ]);
  });

  it('reads a renamed file, and gives no hunk for a pure rename or a binary file', () => {
    expect(
      parseUnifiedDiff(
        diff(
          'diff --git a/old.ts b/new.ts',
          'similarity index 100%',
          'rename from old.ts',
          'rename to new.ts',
        ),
      ),
    ).toEqual([]);
    expect(
      parseUnifiedDiff(
        diff('diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ'),
      ),
    ).toEqual([]);
    const [hunk] = parseUnifiedDiff(
      diff(
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(hunk?.lines).toHaveLength(2);
  });

  it('keeps content lines that look like headers once inside a hunk', () => {
    const [hunk] = parseUnifiedDiff(
      diff('--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,2 @@', '--- titre', '+++ titre', ' @@ fin'),
    );
    expect(hunk?.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: '-- titre' },
      { kind: 'add', oldNo: null, newNo: 1, text: '++ titre' },
      { kind: 'context', oldNo: 2, newNo: 2, text: '@@ fin' },
    ]);
  });

  it('removes the carriage return at the end of a line', () => {
    const [hunk] = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
    expect(hunk?.lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('is not confused by paths with spaces and accents in the headers', () => {
    const hunks = parseUnifiedDiff(
      diff(
        'diff --git a/dossier é/a b.ts b/dossier é/a b.ts',
        'index 1111111..2222222 100644',
        '--- a/dossier é/a b.ts',
        '+++ b/dossier é/a b.ts',
        '@@ -1 +1 @@',
        '-é',
        '+è',
      ),
    );
    expect(hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: 'del', oldNo: 1, newNo: null, text: 'é' },
          { kind: 'add', oldNo: null, newNo: 1, text: 'è' },
        ],
      },
    ]);
  });

  it('returns no hunk for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
