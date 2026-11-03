import { describe, expect, it } from 'vitest';
import { handoffReportSchema, missingFields } from '../../../src/shared/report';

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
