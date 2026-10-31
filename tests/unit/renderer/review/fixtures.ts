import type {
  ChangedFile,
  ConflictFile,
  FileDiff,
  Integration,
  ReviewSnapshot,
} from '../../../../src/shared/review';
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
  testCommand: 'npm test',
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

/** An integration stopped on a conflict in `src/db.ts` (screen 1q). */
export const conflicted = (
  overrides: Partial<Integration> = {},
  file: Partial<ConflictFile> = {},
): Integration => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  agentId: uuid(1),
  mode: 'squash',
  message: 'Ajoute les sessions',
  after: { closeTile: true, removeWorktree: true },
  snapshot: blob(3),
  mainAtStart: blob(4),
  state: 'conflicted',
  conflicts: [
    {
      path: 'src/db.ts',
      kind: 'content',
      mainCommit: { short: 'a41f2c0', subject: 'Ajout SSO' },
      hunks: [
        {
          index: 0,
          line: 42,
          main: ['<Button sso>'],
          agent: ['<OtpForm code />'],
          resolution: null,
        },
        { index: 1, line: 60, main: ['a'], agent: ['b'], resolution: null },
      ],
      edited: null,
      resolved: false,
      merged:
        'x\n<<<<<<< main\n<Button sso>\n=======\n<OtpForm code />\n>>>>>>> agent\ny\n<<<<<<< main\na\n=======\nb\n>>>>>>> agent\n',
      whole: false,
      binary: false,
      deleted: null,
      ...file,
    },
    {
      path: 'src/auth.ts',
      kind: 'delete-modify',
      mainCommit: { short: 'b52e3d1', subject: 'Retire auth' },
      hunks: [{ index: 0, line: 1, main: [], agent: ['export {};'], resolution: null }],
      edited: null,
      resolved: false,
      merged: '',
      whole: true,
      binary: false,
      deleted: 'main',
    },
  ],
  error: null,
  ...overrides,
});
