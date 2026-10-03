import type { ChangedFile, FileDiff, ReviewSnapshot } from '../../../../src/shared/review';
import { uuid } from '../tiles/fixtures';

export const blob = (n: number) => String(n).padStart(40, '0');

export const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: 'modified',
  added: 3,
  removed: 1,
  binary: false,
  tooLarge: false,
  eolOnly: false,
  blob: blob(path.length),
  ...overrides,
});

export const snapshot = (overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  agentId: uuid(1),
  base: blob(1),
  tree: blob(2),
  branch: 'agent/pg-sessions',
  files: [
    file('src/auth.ts', { added: 84, removed: 0, status: 'added' }),
    file('src/db.ts', { added: 12, removed: 6 }),
    file('src/old.ts', { added: 0, removed: 30, status: 'deleted', blob: null }),
  ],
  added: 96,
  removed: 36,
  conflicts: 'none',
  mainHead: blob(1),
  newSinceSeen: null,
  missing: false,
  ...overrides,
});

export const diff = (path = 'src/db.ts', overrides: Partial<FileDiff> = {}): FileDiff => ({
  path,
  size: 420,
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'import { pool } from "./pool";' },
        { kind: 'del', oldNo: 2, newNo: null, text: 'const timeout = 10;' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'const timeout = 30;' },
      ],
    },
  ],
  ...overrides,
});
