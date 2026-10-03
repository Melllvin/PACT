import type { ChangedFile } from '../../shared/review';

// 002 R2 — the machine-readable output of `git diff` (`--raw -z`, `--numstat -z`).

export type Counts = { added: number | null; removed: number | null };

const STATUSES: Partial<Record<string, ChangedFile['status']>> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
};
type RawEntry = Pick<ChangedFile, 'status' | 'path' | 'oldPath' | 'blob'>;
const NULL_ID = /^0*$/;

/** `diff --raw -z`: `:mode mode old new X\0path\0`, with `old\0new\0` for a rename. */
export function parseRaw(text: string): RawEntry[] {
  const parts = text.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const meta = parts[i++]?.split(' ') ?? [];
    const newId = meta[3] ?? '';
    const letter = (meta[4] ?? '').charAt(0);
    const first = parts[i++] ?? '';
    const renamed = letter === 'R' || letter === 'C';
    const second = renamed ? (parts[i++] ?? '') : first;
    entries.push({
      status: letter === 'C' ? 'added' : (STATUSES[letter] ?? 'modified'),
      path: second,
      oldPath: letter === 'R' ? first : null,
      blob: NULL_ID.test(newId) ? null : newId,
    });
  }
  return entries;
}

/** `diff --numstat -z`: `a\tr\tpath\0`, or `a\tr\t\0old\0new\0`; `-` for binary files. */
export function parseNumstat(text: string): Map<string, Counts> {
  const parts = text.split('\0');
  const counts = new Map<string, Counts>();
  for (let i = 0; i < parts.length - 1;) {
    const [added = '', removed = '', path = ''] = (parts[i++] ?? '').split('\t');
    const target = path === '' ? (i++, parts[i++] ?? '') : path;
    counts.set(target, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    });
  }
  return counts;
}
