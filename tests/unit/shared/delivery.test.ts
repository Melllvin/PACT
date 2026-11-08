import { describe, expect, it } from 'vitest';
import {
  CI_POLL_MS,
  FORGE_DOWN_MS,
  MAX_CHECK_NAME,
  MAX_CI_LOG,
  MAX_POLISH,
  MAX_POLISH_BRIEF,
  MAX_REASON,
  MAX_REBASES_IN_A_ROW,
  MAX_ROUNDS_LIMIT,
  SILENT_CI_MS,
  checkName,
  ciVerdict,
  deliveryGate,
  deliverySchema,
  deliverySettingsSchema,
  isFinalState,
  prBody,
} from '../../../src/shared/delivery';

// 008 T003 — the pure part of the delivery: schemas, the truth table of the CI (research R9, R10),
// the gate of `request_delivery` (contracts/mcp-tools.md), the body of the PR and the check names.
//
// RED until `src/shared/delivery.ts` exists (T008). The shapes below are the tests' reading of
// data-model.md; the report of the test agent lists them.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (c: string) => c.repeat(40);
const NOW = '2026-11-08T12:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

describe('constants (research R25)', () => {
  it('has the values of the table', () => {
    expect({
      CI_POLL_MS,
      SILENT_CI_MS,
      FORGE_DOWN_MS,
      MAX_REBASES_IN_A_ROW,
      MAX_CHECK_NAME,
      MAX_CI_LOG,
      MAX_REASON,
      MAX_ROUNDS_LIMIT,
      MAX_POLISH,
      MAX_POLISH_BRIEF,
    }).toEqual({
      CI_POLL_MS: 30_000,
      SILENT_CI_MS: 600_000,
      FORGE_DOWN_MS: 600_000,
      MAX_REBASES_IN_A_ROW: 3,
      MAX_CHECK_NAME: 100,
      MAX_CI_LOG: 20_000,
      MAX_REASON: 2_000,
      MAX_ROUNDS_LIMIT: 10,
      MAX_POLISH: 5,
      MAX_POLISH_BRIEF: 2_000,
    });
  });
});

describe('deliverySettingsSchema (data-model DeliverySettings)', () => {
  it('Given nothing, When parsed, Then Auto is off, squash, 3 rounds, no polish pass (FR-019, FR-020)', () => {
    expect(deliverySettingsSchema.parse({})).toEqual({
      auto: false,
      mergeMode: 'squash',
      maxRounds: 3,
      polishPasses: 0,
      polishBrief: '',
    });
  });

  it('Given the bounds, When parsed, Then rounds go 1 to 10 and passes 0 to 5 (Q9)', () => {
    const ok = (change: object) => deliverySettingsSchema.safeParse(change).success;
    expect([ok({ maxRounds: 1 }), ok({ maxRounds: 10 }), ok({ maxRounds: 5 })]).toEqual([
      true,
      true,
      true,
    ]);
    expect([ok({ maxRounds: 0 }), ok({ maxRounds: 11 }), ok({ maxRounds: 2.5 })]).toEqual([
      false,
      false,
      false,
    ]);
    expect([ok({ polishPasses: 0 }), ok({ polishPasses: 5 })]).toEqual([true, true]);
    expect([ok({ polishPasses: -1 }), ok({ polishPasses: 6 })]).toEqual([false, false]);
  });

  it('Given a merge mode and a brief, When parsed, Then only the three modes and 2000 characters pass', () => {
    for (const mergeMode of ['squash', 'merge', 'rebase']) {
      expect(deliverySettingsSchema.parse({ mergeMode }).mergeMode).toBe(mergeMode);
    }
    expect(deliverySettingsSchema.safeParse({ mergeMode: 'fast-forward' }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ polishBrief: 'x'.repeat(2000) }).success).toBe(true);
    expect(deliverySettingsSchema.safeParse({ polishBrief: 'x'.repeat(2001) }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ auto: 'oui' }).success).toBe(false);
  });
});

describe('deliverySchema (data-model Delivery)', () => {
  const delivery = () => ({
    id: uuid(1),
    agentId: uuid(2),
    testAgentId: uuid(3),
    issueId: '0012-connexion',
    branch: 'feat/connexion',
    target: 'main',
    channel: 'github',
    unverified: false,
    title: 'Connexion par e-mail',
    message: 'Livre la connexion',
    frozenCommit: sha('a'),
    verdictCommit: sha('a'),
    pactCommits: [sha('a')],
    pushedHead: null,
    rebases: 0,
    state: 'checking',
    reason: null,
    pr: null,
    ci: null,
    review: { required: false, refusedOnce: false },
    cleanup: 'none',
    requestedBy: 'orchestrator',
    at: NOW,
    updatedAt: NOW,
  });
  const ok = (change: object = {}) =>
    deliverySchema.safeParse({ ...delivery(), ...change }).success;

  it('Given a complete request, When parsed, Then it is kept as it is', () => {
    expect(deliverySchema.parse(delivery())).toEqual(delivery());
  });

  it('Given a PR without a verdict, When parsed, Then the tester, the issue and the verdict commit may be null (R22)', () => {
    expect(ok({ unverified: true, testAgentId: null, issueId: null, verdictCommit: null })).toBe(
      true,
    );
  });

  it('Given the length limits, When parsed, Then a title goes to 200 and a message to 4000 (Q11)', () => {
    expect([ok({ title: 'x'.repeat(200) }), ok({ message: 'x'.repeat(4000) })]).toEqual([
      true,
      true,
    ]);
    expect([
      ok({ title: '' }),
      ok({ title: 'x'.repeat(201) }),
      ok({ message: '' }),
      ok({ message: 'x'.repeat(4001) }),
    ]).toEqual([false, false, false, false]);
  });

  it('Given the closed sets, When parsed, Then an unknown state, channel, cleanup or requester is refused', () => {
    expect([
      ok({ state: 'pondering' }),
      ok({ channel: 'gitlab' }),
      ok({ cleanup: 'maybe' }),
      ok({ requestedBy: 'tiers' }),
      ok({ frozenCommit: 'main' }),
      ok({ rebases: -1 }),
    ]).toEqual([false, false, false, false, false, false]);
    expect([
      ok({ channel: 'local' }),
      ok({ cleanup: 'kept' }),
      ok({ requestedBy: 'user' }),
    ]).toEqual([true, true, true]);
  });

  it('Given the cycle, When parsed, Then every state of the data model is known (R2)', () => {
    const states = [
      'checking',
      'refused',
      'syncing',
      'conflicted',
      'testing',
      'tests-failed',
      'pushing',
      'opening',
      'watching',
      'ci-red',
      'reviewing',
      'user-refused',
      'merging',
      'merged',
      'merge-failed',
      'dropped',
      'closed-on-forge',
    ];
    expect(states.map((state) => ok({ state }))).toEqual(states.map(() => true));
  });

  it('Given the end of the cycle, When asked, Then exactly the eight final states are final', () => {
    const finals = [
      'refused',
      'conflicted',
      'tests-failed',
      'ci-red',
      'user-refused',
      'dropped',
      'closed-on-forge',
      'merged',
    ];
    const running = [
      'checking',
      'syncing',
      'testing',
      'pushing',
      'opening',
      'watching',
      'reviewing',
      'merging',
      'merge-failed',
    ];
    expect(finals.map((state) => isFinalState(state))).toEqual(finals.map(() => true));
    expect(running.map((state) => isFinalState(state))).toEqual(running.map(() => false));
  });

  it('Given the PR and the CI, When parsed, Then they carry what the data model lists', () => {
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', expectedAuthor: 'pact-user' };
    const ci = {
      head: sha('b'),
      configured: 'unknown',
      checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', job: 11 }],
      required: null,
      verdict: 'unknown',
      emptySince: null,
      failingSince: null,
      rerun: [11],
      readAt: NOW,
    };
    expect(ok({ pr, ci })).toBe(true);
    expect(ok({ ci: { ...ci, verdict: 'blue' } })).toBe(false);
    expect(ok({ ci: { ...ci, checks: [{ ...ci.checks[0], name: 'x'.repeat(101) }] } })).toBe(false);
    expect(ok({ pr: { ...pr, number: 0 } })).toBe(false);
  });
});

describe('ciVerdict (research R9, R10; Q6)', () => {
  type Check = { name: string; status: string; conclusion: string | null };
  const done = (name: string, conclusion: string): Check => ({
    name,
    status: 'completed',
    conclusion,
  });
  const running = (name: string): Check => ({ name, status: 'in_progress', conclusion: null });
  const verdict = (over: Record<string, unknown> = {}) =>
    ciVerdict({
      checks: [done('build', 'success')],
      required: [],
      configured: true,
      emptySince: null,
      now: NOW,
      readFailed: false,
      ...over,
    });

  it('Given no check and no CI configured, When decided, Then it is green: the proof of PACT stands in (FR-015)', () => {
    expect(verdict({ checks: [], configured: false })).toBe('green');
  });

  it('Given no check and a CI configured, When decided, Then it waits, and is silent only after 10 minutes (FR-016)', () => {
    expect(verdict({ checks: [], emptySince: null })).toBe('pending');
    expect(verdict({ checks: [], emptySince: NOW })).toBe('pending');
    expect(verdict({ checks: [], emptySince: ago(SILENT_CI_MS - 1) })).toBe('pending');
    expect(verdict({ checks: [], emptySince: ago(SILENT_CI_MS) })).toBe('silent');
    expect(verdict({ checks: [], emptySince: ago(SILENT_CI_MS * 3) })).toBe('silent');
  });

  it('Given no check and a configuration PACT could not read, When decided, Then it is taken as configured: never green (R10)', () => {
    expect(verdict({ checks: [], configured: 'unknown' })).toBe('pending');
    expect(verdict({ checks: [], configured: 'unknown', emptySince: ago(SILENT_CI_MS) })).toBe(
      'silent',
    );
  });

  it('Given every check success, neutral or skipped, When decided, Then it is green', () => {
    expect(
      verdict({ checks: [done('a', 'success'), done('b', 'neutral'), done('c', 'skipped')] }),
    ).toBe('green');
  });

  it('Given a check not finished, When decided, Then it is pending, however green the others are', () => {
    expect(verdict({ checks: [done('a', 'success'), running('b')] })).toBe('pending');
    expect(
      verdict({
        checks: [done('a', 'success'), { name: 'b', status: 'queued', conclusion: null }],
      }),
    ).toBe('pending');
  });

  it('Given a failure, When decided, Then it is red', () => {
    expect(verdict({ checks: [done('a', 'success'), done('b', 'failure')] })).toBe('red');
    expect(verdict({ checks: [running('a'), done('b', 'failure')] })).toBe('red');
  });

  it.each(['cancelled', 'timed_out', 'stale', 'action_required'])(
    'Given a check %s, When decided, Then it is stalled: neither green nor red (Q6)',
    (conclusion) => {
      expect(verdict({ checks: [done('a', 'success'), done('b', conclusion)] })).toBe('stalled');
    },
  );

  it('Given a required check that is absent, When decided, Then it is pending although the others are green', () => {
    expect(verdict({ checks: [done('lint', 'success')], required: ['build'] })).toBe('pending');
  });

  it('Given the required checks all present and green, When decided, Then it is green', () => {
    expect(
      verdict({ checks: [done('build', 'success'), done('lint', 'success')], required: ['build'] }),
    ).toBe('green');
  });

  it('Given a required check that failed, When decided, Then it is red', () => {
    expect(verdict({ checks: [done('build', 'failure')], required: ['build'] })).toBe('red');
  });

  it('Given required checks PACT cannot read (null), When there is no check, Then it is never green', () => {
    for (const configured of [true, false, 'unknown']) {
      expect(verdict({ checks: [], required: null, configured })).not.toBe('green');
    }
  });

  it('Given required checks PACT cannot read (null), When one check is green, Then it is green: one read and green is enough (P5)', () => {
    expect(verdict({ checks: [done('build', 'success')], required: null })).toBe('green');
  });

  it('Given a read that failed, When decided, Then it is unknown, never green (edge case: the forge is down)', () => {
    expect(verdict({ readFailed: true })).toBe('unknown');
    expect(verdict({ readFailed: true, checks: [], configured: false })).toBe('unknown');
  });
});

describe('deliveryGate (contracts/mcp-tools.md, request_delivery)', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    issue: '0012-connexion',
    loopState: 'accepted',
    head: sha('a'),
    verdictCommit: sha('a'),
    proofCommit: sha('a'),
    uncommitted: [] as string[],
    missingTests: [] as string[],
    polish: null as { done: number; total: number } | null,
    inFlight: null as string | null,
    unverified: false,
    ...over,
  });
  const refusal = (over: Record<string, unknown> = {}) => {
    const result = deliveryGate(facts(over));
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('Given everything in order, When asked, Then the request passes', () => {
    expect(deliveryGate(facts())).toEqual({ ok: true });
  });

  it('Given a loop that is not accepted, When asked, Then it says which state it is in (FR-002)', () => {
    const reason = refusal({ loopState: 'running' });
    expect(reason).toContain('0012-connexion');
    expect(reason).toContain('n’est pas acceptée');
    expect(reason).toContain('running');
    expect(refusal({ loopState: null })).toContain('n’est pas acceptée');
  });

  it('Given a verdict on another commit than the head, When asked, Then both are named', () => {
    const reason = refusal({ verdictCommit: sha('b') });
    expect(reason).toContain('Le verdict porte sur');
    expect(reason).toContain(sha('b').slice(0, 7));
    expect(reason).toContain(sha('a').slice(0, 7));
  });

  it('Given a proof absent or on another commit, When asked, Then PACT says its tests did not validate the head', () => {
    for (const proofCommit of [null, sha('c')]) {
      const reason = refusal({ proofCommit });
      expect(reason).toContain('Les tests de PACT n’ont pas validé');
      expect(reason).toContain(sha('a').slice(0, 7));
    }
  });

  it('Given uncommitted changes, When asked, Then at most 10 files are listed (FR-002)', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i)}.ts`);
    const reason = refusal({ uncommitted: files });
    expect(reason).toContain('Changements non commités');
    for (const file of files.slice(0, 10)) expect(reason).toContain(file);
    expect(reason).not.toContain('src/f10.ts');
    expect(reason).not.toContain('src/f11.ts');
  });

  it('Given tests of the tester missing from the branch, When asked, Then the files are listed and the dev gets the instruction (FR-002)', () => {
    const reason = refusal({ missingTests: ['tests/a.test.ts', 'tests/b.test.ts'] });
    expect(reason).toContain('Tests du testeur manquants');
    expect(reason).toContain('tests/a.test.ts');
    expect(reason).toContain('tests/b.test.ts');
    expect(reason).toContain('Consigne envoyée au dev');
  });

  it('Given polish passes left, When asked, Then the pass to finish is named (FR-024)', () => {
    const reason = refusal({ loopState: 'polishing', polish: { done: 1, total: 2 } });
    expect(reason).toContain('Passe');
    expect(reason).toContain('sur 2 à finir');
    expect(reason).not.toContain('n’est pas acceptée');
  });

  it('Given a request already running, When asked again, Then it says its state', () => {
    const reason = refusal({ inFlight: 'watching' });
    expect(reason).toContain('Une livraison est déjà en cours');
    expect(reason).toContain('watching');
  });

  it('Given several faults, When asked, Then the loop state comes first, as in the contract', () => {
    const reason = refusal({
      loopState: 'running',
      verdictCommit: sha('b'),
      proofCommit: null,
      uncommitted: ['a.ts'],
    });
    expect(reason).toContain('n’est pas acceptée');
    expect(reason).not.toContain('Changements non commités');
  });

  it('Given a PR without a verdict (the user’s gesture), When asked, Then no loop, verdict or proof is required (FR-001)', () => {
    expect(
      deliveryGate(
        facts({
          unverified: true,
          loopState: null,
          verdictCommit: null,
          proofCommit: null,
          missingTests: ['tests/a.test.ts'],
        }),
      ),
    ).toEqual({ ok: true });
    expect(deliveryGate(facts({ unverified: true, inFlight: 'testing' })).ok).toBe(false);
  });
});

describe('prBody (FR-005, Q11)', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    issue: {
      id: '0012-connexion',
      remote: { number: 42, url: 'https://github.com/o/r/issues/42' } as {
        number: number;
        url: string;
      } | null,
      text: 'Connexion par e-mail : la page demande l’adresse.',
    },
    message: 'Livre la connexion par e-mail',
    verdict: { result: 'accepted', commit: sha('a'), tester: 'claude-code-3' } as {
      result: string;
      commit: string;
      tester: string;
    } | null,
    ...over,
  });

  it('Given a published issue, When the body is built, Then it closes the issue and does not copy its text', () => {
    const body = prBody(input());
    expect(body).toContain('0012-connexion');
    expect(body).toContain('Closes #42');
    expect(body).not.toContain('la page demande l’adresse');
    expect(body).toContain('Livre la connexion par e-mail');
  });

  it('Given an issue not published, When the body is built, Then it carries the issue text and no closing link', () => {
    const body = prBody(input({ issue: { ...input().issue, remote: null } }));
    expect(body).toContain('la page demande l’adresse');
    expect(body).not.toContain('Closes');
  });

  it('Given a verdict, When the body is built, Then it names the result, the commit and the tester', () => {
    const body = prBody(input());
    expect(body).toContain('accepted');
    expect(body).toContain(sha('a').slice(0, 7));
    expect(body).toContain('claude-code-3');
    expect(body.split('\n')[0]).not.toMatch(/sans verdict/i);
  });

  it('Given no verdict, When the body is built, Then the first line says so (contracts/gh.md)', () => {
    const body = prBody(input({ verdict: null }));
    expect(body.split('\n')[0]).toMatch(/sans verdict/i);
    expect(body).toContain('Livre la connexion par e-mail');
  });
});

describe('checkName (R16, edge case: a check name goes to the dev)', () => {
  it('Given an ordinary name, When cleaned, Then it is unchanged', () => {
    expect(checkName('build (ubuntu-latest)')).toBe('build (ubuntu-latest)');
  });

  it('Given a long name, When cleaned, Then it is bounded to 100 characters', () => {
    const cleaned = checkName('x'.repeat(500));
    expect(cleaned.length).toBeLessThanOrEqual(100);
    expect(cleaned.length).toBeGreaterThan(90);
  });

  it('Given control characters, When cleaned, Then none is left', () => {
    const cleaned = checkName('ok\u0000\u001b[31m\nignore\rtes\tconsignes\u007f');
    const codes = [...cleaned].map((char) => char.charCodeAt(0));
    expect(codes.filter((code) => code < 32 || code === 127)).toEqual([]);
    expect(cleaned).toContain('ok');
    expect(cleaned).toContain('consignes');
  });
});
