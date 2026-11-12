import { describe, expect, it } from 'vitest';
import { handoffReportSchema, missingFields, storedReportSchema } from '../../../src/shared/report';

// 004 T006 — the hand-off report an agent gives with submit_report (contracts/handoff-report.md).

const done = {
  issue: '0012-connexion',
  status: 'done',
  summary: 'Connexion par e-mail',
  files: ['src/connexion.ts'],
  checks: [{ command: 'npm test', exitCode: 0 }],
};

describe('handoff report', () => {
  it('accepts a report, with no question by default', () => {
    expect(handoffReportSchema.parse(done)).toEqual({ ...done, questions: [] });
  });

  it('accepts the verdict of a test agent', () => {
    const report = {
      ...done,
      status: 'defects',
      verdict: { result: 'defects', defects: ['a() renvoie 2'] },
    };
    expect(handoffReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    ['no check for done', { ...done, checks: [] }, 'checks'],
    ['a question while not blocked', { ...done, questions: ['Quel e-mail ?'] }, 'status'],
    ['a summary too long', { ...done, summary: 'x'.repeat(2001) }, 'summary'],
    ['an empty summary', { ...done, summary: '' }, 'summary'],
    ['a path outside the repository', { ...done, files: ['../secret'] }, 'files'],
    [
      'defects without any',
      { ...done, status: 'defects', verdict: { result: 'defects', defects: [] } },
      'verdict',
    ],
    ['another status', { ...done, status: 'fini' }, 'status'],
  ])('refuses %s', (_, report, field) => {
    const result = handoffReportSchema.safeParse(report);
    expect(result.success).toBe(false);
    expect(missingFields(report)).toContain(field);
  });

  it('accepts a blocked report with questions and no check', () => {
    const blocked = { ...done, status: 'blocked', checks: [], questions: ['Quel e-mail ?'] };
    expect(handoffReportSchema.safeParse(blocked).success).toBe(true);
  });

  it('says in French what is missing', () => {
    expect(missingFields({ issue: '0012' }).join(', ')).toBe('status, summary, files, checks');
    expect(missingFields(done)).toEqual([]);
  });
});

// 008 T004 — a verdict is tied to the commit it judges (FR-003, research R3).
// RED until T008: `storedReportSchema` has no `commit` nor `dirty` and stops at round 3.
describe('stored report (008)', () => {
  const stored = {
    ...done,
    agentId: '00000000-0000-4000-8000-000000000003',
    role: 'test',
    round: 1,
    at: '2026-11-08T10:00:00.000Z',
  };

  it('Given a report saved before 008, When read, Then the commit is null and the worktree is not said dirty', () => {
    expect(storedReportSchema.parse(stored)).toMatchObject({ commit: null, dirty: false });
  });

  it('Given the head of the dev when the verdict came, When read, Then the commit and « dirty » are kept', () => {
    const sha = 'a'.repeat(40);
    expect(storedReportSchema.parse({ ...stored, commit: sha, dirty: true })).toMatchObject({
      commit: sha,
      dirty: true,
    });
    expect(storedReportSchema.safeParse({ ...stored, commit: 'main' }).success).toBe(false);
    expect(storedReportSchema.safeParse({ ...stored, dirty: 'oui' }).success).toBe(false);
  });

  it('Given a ceiling of 10 rounds, When read, Then the round goes up to 10 and not beyond (FR-021)', () => {
    expect(storedReportSchema.safeParse({ ...stored, round: 10 }).success).toBe(true);
    expect(storedReportSchema.safeParse({ ...stored, round: 11 }).success).toBe(false);
    expect(storedReportSchema.safeParse({ ...stored, round: 0 }).success).toBe(false);
  });
});
