import { describe, expect, it } from 'vitest';
import {
  applyResolutions,
  choicesFor,
  hasConflictMarkers,
  isFileResolved,
  parseConflicts,
  resultOf,
} from '../../../src/shared/conflicts';
import type { ConflictFile } from '../../../src/shared/review';

// 002 T043 — the conflicts of a file merged by git, cut into hunks, and the choices applied
// (research R6).

const text = (...lines: string[]) => `${lines.join('\n')}\n`;

const merged = text(
  'un',
  '<<<<<<< main',
  'deux de main',
  '=======',
  'deux de l’agent',
  'et plus',
  '>>>>>>> agent',
  'trois',
  '<<<<<<< main',
  '=======',
  'quatre de l’agent',
  '>>>>>>> agent',
  'fin',
);

const file = (overrides: Partial<ConflictFile> = {}): ConflictFile => ({
  path: 'a.txt',
  kind: 'content',
  mainCommit: { short: 'a41f2c0', subject: 'Ajout SSO' },
  hunks: parseConflicts(merged),
  edited: null,
  resolved: false,
  merged,
  whole: false,
  binary: false,
  deleted: null,
  ...overrides,
});

describe('parseConflicts', () => {
  it('cuts the markers into hunks, main first, numbered on the main side', () => {
    expect(parseConflicts(merged)).toEqual([
      {
        index: 0,
        line: 2,
        main: ['deux de main'],
        agent: ['deux de l’agent', 'et plus'],
        resolution: null,
      },
      { index: 1, line: 4, main: [], agent: ['quatre de l’agent'], resolution: null },
    ]);
  });

  it('leaves out the base of a diff3 conflict', () => {
    const diff3 = text('<<<<<<< main', 'm', '||||||| base', 'b', '=======', 'a', '>>>>>>> agent');
    expect(parseConflicts(diff3)).toEqual([
      { index: 0, line: 1, main: ['m'], agent: ['a'], resolution: null },
    ]);
  });

  it('reads Windows line endings, which it keeps in the lines', () => {
    const crlf = '<<<<<<< main\r\nm\r\n=======\r\na\r\n>>>>>>> agent\r\n';
    expect(parseConflicts(crlf)).toEqual([
      { index: 0, line: 1, main: ['m\r'], agent: ['a\r'], resolution: null },
    ]);
  });

  it('finds nothing in a file without markers', () => {
    expect(parseConflicts(text('un', 'deux'))).toEqual([]);
  });
});

describe('applyResolutions', () => {
  it('replaces each hunk by the side chosen, both sides main first', () => {
    const [first, second] = parseConflicts(merged);
    if (!first || !second) throw new Error('two hunks expected');
    expect(
      applyResolutions(merged, [
        { ...first, resolution: 'both' },
        { ...second, resolution: 'agent' },
      ]),
    ).toBe(
      text('un', 'deux de main', 'deux de l’agent', 'et plus', 'trois', 'quatre de l’agent', 'fin'),
    );
    expect(
      applyResolutions(merged, [
        { ...first, resolution: 'main' },
        { ...second, resolution: 'main' },
      ]),
    ).toBe(text('un', 'deux de main', 'trois', 'fin'));
  });

  it('keeps the markers of a hunk not resolved yet', () => {
    const [first, second] = parseConflicts(merged);
    if (!first || !second) throw new Error('two hunks expected');
    const partial = applyResolutions(merged, [{ ...first, resolution: 'agent' }, second]);
    expect(hasConflictMarkers(partial)).toBe(true);
    expect(
      partial.startsWith(text('un', 'deux de l’agent', 'et plus', 'trois', '<<<<<<< main')),
    ).toBe(true);
  });
});

describe('hasConflictMarkers', () => {
  it('sees <<<<<<< or >>>>>>> at the start of a line, nothing else', () => {
    expect(hasConflictMarkers(merged)).toBe(true);
    expect(hasConflictMarkers(text('a', '>>>>>>> b'))).toBe(true);
    expect(hasConflictMarkers(text('a <<<<<<< b', '======='))).toBe(false);
  });
});

describe('isFileResolved and resultOf', () => {
  it('is resolved once every hunk has a choice', () => {
    const [first, second] = file().hunks;
    if (!first || !second) throw new Error('two hunks expected');
    expect(isFileResolved(file())).toBe(false);
    expect(isFileResolved(file({ hunks: [{ ...first, resolution: 'main' }, second] }))).toBe(false);
    const done = file({
      hunks: [
        { ...first, resolution: 'main' },
        { ...second, resolution: 'agent' },
      ],
    });
    expect(isFileResolved(done)).toBe(true);
    expect(resultOf(done)).toBe(text('un', 'deux de main', 'trois', 'quatre de l’agent', 'fin'));
  });

  it('is resolved by an edit once no marker is left, whatever the hunks say', () => {
    expect(isFileResolved(file({ edited: text('un', 'deux', 'fin') }))).toBe(true);
    expect(isFileResolved(file({ edited: merged }))).toBe(false);
    expect(resultOf(file({ edited: 'à la main\n' }))).toBe('à la main\n');
  });

  it('gives the side chosen of a file chosen whole', () => {
    const whole = file({
      whole: true,
      merged: '',
      hunks: [{ index: 0, line: 1, main: ['m'], agent: ['a'], resolution: 'agent' }],
    });
    expect(isFileResolved(whole)).toBe(true);
    expect(resultOf(whole)).toBe('a\n');
  });
});

describe('choicesFor', () => {
  it('offers both sides only for a content conflict (R6)', () => {
    expect(choicesFor(file())).toEqual(['main', 'agent', 'both']);
    expect(choicesFor(file({ kind: 'delete-modify', whole: true }))).toEqual(['main', 'agent']);
    expect(choicesFor(file({ kind: 'add-add', whole: true }))).toEqual(['main', 'agent']);
  });
});
