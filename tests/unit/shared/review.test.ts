import { describe, expect, it } from 'vitest';
import {
  changedFileSchema,
  conflictFileSchema,
  fileDiffSchema,
  integrationSchema,
  reviewSnapshotSchema,
  testRunSchema,
} from '../../../src/shared/review';

// 002 T005 — review types sent over IPC (data-model.md, « In memory »).

const agentId = '00000000-0000-4000-8000-000000000001';
const sha = (c: string) => c.repeat(40);

const file = {
  path: 'src/Développement é.ts',
  oldPath: null,
  status: 'modified',
  added: 3,
  removed: 1,
  binary: false,
  tooLarge: false,
  eolOnly: false,
  blob: sha('b'),
};

const snapshot = {
  agentId,
  base: sha('1'),
  tree: sha('2'),
  branch: 'agent/claude-code-1',
  files: [file],
  added: 3,
  removed: 1,
  conflicts: 'none',
  mainHead: sha('3'),
  newSinceSeen: null,
  missing: false,
};

const conflict = {
  path: 'src/a.ts',
  kind: 'content',
  mainCommit: { short: 'abc1234', subject: 'Corrige le total' },
  hunks: [{ index: 0, line: 12, main: ['a'], agent: ['b'], resolution: null }],
  edited: null,
  resolved: false,
};

const integration = {
  id: '00000000-0000-4000-8000-000000000002',
  agentId,
  mode: 'squash',
  message: 'Ajoute le total',
  after: { closeTile: true, removeWorktree: true },
  snapshot: sha('4'),
  mainAtStart: sha('3'),
  state: 'checking',
  conflicts: [],
  error: null,
};

describe('ChangedFile', () => {
  it.each(['added', 'modified', 'deleted', 'renamed'])('accepts status %s', (status) => {
    expect(changedFileSchema.safeParse({ ...file, status }).success).toBe(true);
  });

  it('rejects another status', () => {
    expect(changedFileSchema.safeParse({ ...file, status: 'copied' }).success).toBe(false);
  });

  it('has no line counts for a binary file and no blob once deleted', () => {
    expect(
      changedFileSchema.safeParse({ ...file, binary: true, added: null, removed: null }).success,
    ).toBe(true);
    expect(changedFileSchema.safeParse({ ...file, status: 'deleted', blob: null }).success).toBe(
      true,
    );
  });

  it('keeps the old path of a renamed file', () => {
    const renamed = { ...file, status: 'renamed', oldPath: 'src/old.ts' };
    expect(changedFileSchema.parse(renamed).oldPath).toBe('src/old.ts');
  });

  it('rejects negative line counts', () => {
    expect(changedFileSchema.safeParse({ ...file, added: -1 }).success).toBe(false);
  });
});

describe('ReviewSnapshot', () => {
  it('accepts a snapshot', () => {
    expect(reviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it.each([['none'], ['checking'], [['src/a.ts']]])('accepts conflicts %j', (conflicts) => {
    expect(reviewSnapshotSchema.safeParse({ ...snapshot, conflicts }).success).toBe(true);
  });

  it('carries the new changes since seen, or null', () => {
    const newSinceSeen = { added: 2, removed: 0 };
    expect(reviewSnapshotSchema.parse({ ...snapshot, newSinceSeen }).newSinceSeen).toEqual(
      newSinceSeen,
    );
  });

  it('rejects a base that is not a commit id', () => {
    expect(reviewSnapshotSchema.safeParse({ ...snapshot, base: 'main' }).success).toBe(false);
  });
});

describe('FileDiff', () => {
  it('holds hunks of context, added and removed lines with their numbers', () => {
    const diff = {
      path: 'a.ts',
      size: 120,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { kind: 'context', oldNo: 1, newNo: 1, text: 'a' },
            { kind: 'del', oldNo: 2, newNo: null, text: 'b' },
            { kind: 'add', oldNo: null, newNo: 2, text: 'c' },
          ],
        },
      ],
    };
    expect(fileDiffSchema.safeParse(diff).success).toBe(true);
    expect(fileDiffSchema.safeParse({ path: 'a.png', size: 2048, hunks: [] }).success).toBe(true);
  });

  it('rejects an unknown line kind', () => {
    const hunk = {
      oldStart: 1,
      newStart: 1,
      lines: [{ kind: 'moved', oldNo: 1, newNo: 1, text: '' }],
    };
    expect(fileDiffSchema.safeParse({ path: 'a', size: 1, hunks: [hunk] }).success).toBe(false);
  });
});

describe('TestRun', () => {
  const run = {
    agentId,
    command: 'npm test',
    tree: sha('2'),
    status: 'passed',
    passedCount: 42,
    outputTail: 'Tests  42 passed (42)',
  };

  it.each(['running', 'passed', 'failed', 'cancelled', 'timeout'])(
    'accepts status %s',
    (status) => {
      expect(testRunSchema.safeParse({ ...run, status }).success).toBe(true);
    },
  );

  it('has no count when the summary was not recognised', () => {
    expect(testRunSchema.safeParse({ ...run, passedCount: null }).success).toBe(true);
  });

  it('rejects an empty command', () => {
    expect(testRunSchema.safeParse({ ...run, command: '' }).success).toBe(false);
  });
});

describe('Integration', () => {
  it.each([
    'checking',
    'conflicted',
    'waiting-agent',
    'committing',
    'integrated',
    'blocked',
    'failed',
    'cancelled',
  ])('accepts state %s', (state) => {
    expect(integrationSchema.safeParse({ ...integration, state }).success).toBe(true);
  });

  it('defaults to squash, closing the tile and removing the worktree (FR-019, FR-024)', () => {
    const { mode: _, after: __, ...rest } = integration;
    expect(integrationSchema.parse(rest)).toMatchObject({
      mode: 'squash',
      after: { closeTile: true, removeWorktree: true },
    });
  });

  it('accepts keep-commits and refuses an empty message', () => {
    expect(integrationSchema.safeParse({ ...integration, mode: 'keep-commits' }).success).toBe(
      true,
    );
    expect(integrationSchema.safeParse({ ...integration, message: '' }).success).toBe(false);
  });

  it('carries the conflicts and git error as it came', () => {
    expect(
      integrationSchema.safeParse({
        ...integration,
        state: 'failed',
        conflicts: [conflict],
        error: 'hook pre-commit: exit 1',
      }).success,
    ).toBe(true);
  });
});

describe('ConflictFile', () => {
  it.each(['content', 'delete-modify', 'add-add'])('accepts kind %s', (kind) => {
    expect(conflictFileSchema.safeParse({ ...conflict, kind }).success).toBe(true);
  });

  it.each([null, 'main', 'agent', 'both'])('accepts hunk resolution %s', (resolution) => {
    const hunks = [{ ...conflict.hunks[0], resolution }];
    expect(conflictFileSchema.safeParse({ ...conflict, hunks }).success).toBe(true);
  });

  it('keeps an edited content', () => {
    expect(
      conflictFileSchema.parse({ ...conflict, edited: 'merged\n', resolved: true }).edited,
    ).toBe('merged\n');
  });

  it('rejects an unknown resolution', () => {
    const hunks = [{ ...conflict.hunks[0], resolution: 'theirs' }];
    expect(conflictFileSchema.safeParse({ ...conflict, hunks }).success).toBe(false);
  });
});
