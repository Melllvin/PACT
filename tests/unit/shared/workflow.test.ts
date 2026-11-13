import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDeliverySettings } from '../../../src/shared/delivery';
import type { RoleProfile } from '../../../src/shared/model';
import type { TieredCli } from '../../../src/shared/roles';
import {
  MAX_AGENTS,
  MAX_RUN_HISTORY,
  MAX_STAGES,
  OUTCOMES,
  WORKFLOW_PATH,
  defaultWorkflow,
  defaultWorkflowState,
  equalWorkflows,
  ignoredLocal,
  machineCheck,
  nextStages,
  outcomeOf,
  outcomesOf,
  runSchema,
  terminalOutcome,
  validateWorkflow,
  workflowSchema,
  type Workflow,
} from '../../../src/shared/workflow';
import { loadWorkflow } from '../../../src/shared/workflow-yaml';

// 010 T005, T006, T008 — the schemas, the rules (outcomes, validation, default) and the machine check
// of the workflow, pure (data-model.md, research R4 to R7, R11; contracts/workflow-file.md).

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'workflows');
const read = (dir: string, name: string) => readFileSync(join(FIXTURES, dir, name), 'utf8');
const base = (): Workflow => {
  const { workflow } = loadWorkflow(read('valid', 'default.yaml'));
  if (!workflow) throw new Error('default.yaml must be valid');
  return structuredClone(workflow);
};
/** The workflow as data, run through `validateWorkflow` without lines. */
const check = (change: (w: Workflow) => void) => {
  const w = base();
  change(w);
  return validateWorkflow(w);
};
const codes = (v: { errors: { code: string }[] }) => v.errors.map((e) => e.code);

describe('constants and outcomes', () => {
  it('has the values of research R18', () => {
    expect({ WORKFLOW_PATH, MAX_AGENTS, MAX_STAGES, MAX_RUN_HISTORY }).toEqual({
      WORKFLOW_PATH: '.pact/workflow.yaml',
      MAX_AGENTS: 6,
      MAX_STAGES: 20,
      MAX_RUN_HISTORY: 50,
    });
  });

  it.each([
    ['spec', ['ready']],
    ['design', ['done']],
    ['test', ['tests-written', 'accepted', 'defects']],
    ['dev', ['done']],
    ['polish', ['done']],
    ['pr', ['merged', 'ci-red', 'tests-failed', 'conflicted', 'user-refused']],
    ['recap', ['done']],
  ] as const)('outcomesOf(%s)', (type, outcomes) => {
    expect(outcomesOf(type)).toEqual(outcomes);
    for (const outcome of outcomes) expect(OUTCOMES).toContain(outcome);
  });

  it.each([
    ['pr', 'merged'],
    ['spec', 'ready'],
    ['dev', 'done'],
    ['recap', 'done'],
    ['design', 'done'],
  ] as const)('terminalOutcome(%s) is %s', (type, outcome) => {
    expect(terminalOutcome(type)).toBe(outcome);
  });
});

describe('workflowSchema (data-model)', () => {
  it('accepts the default and gives the defaults of a stage', () => {
    const parsed = workflowSchema.parse({
      version: 1,
      name: 'x',
      agents: { dev: { role: 'dev' }, t: { role: 'test' } },
      stages: [
        { id: 'p', type: 'polish', agents: ['dev', 't'] },
        { id: 'r', type: 'pr' },
      ],
      transitions: [],
      start: 'p',
      ends: ['r'],
    });
    expect(parsed.stages[0]).toMatchObject({ passes: 0 });
    expect(parsed.stages[1]).toMatchObject({ mergeMode: 'squash', agents: [] });
  });

  const wf = (over: Record<string, unknown>) => ({ ...base(), ...over });
  it.each([
    ['name outside [a-z0-9-]', { name: 'Ma Livraison' }],
    ['name over 60', { name: 'a'.repeat(61) }],
    ['an unknown key', { stgaes: [] }],
    ['no stage', { stages: [] }],
    [
      'more than 20 stages',
      { stages: Array.from({ length: 21 }, (_, i) => ({ id: `s${String(i)}`, type: 'pr' })) },
    ],
    ['no end', { ends: [] }],
    ['the orchestrator as an agent', { agents: { o: { role: 'orchestrator' } } }],
    ['an agent key with capitals', { agents: { Dev: { role: 'dev' } } }],
  ])('rejects %s', (_label, over) => {
    expect(workflowSchema.safeParse(wf(over)).success).toBe(false);
  });

  const stage = (over: Record<string, unknown>) => ({
    ...base(),
    stages: [{ id: 's', type: 'dev', ...over }],
  });
  it.each([
    ['an instruction over 2000', { instruction: 'x'.repeat(2001) }],
    ['passes on a dev stage', { passes: 1 }],
    ['mergeMode on a dev stage', { mergeMode: 'squash' }],
    ['a negative position', { position: { x: -1, y: 0 } }],
    ['a fractional position', { position: { x: 1.5, y: 0 } }],
  ])('rejects %s', (_label, over) => {
    expect(workflowSchema.safeParse(stage(over)).success).toBe(false);
  });

  it('bounds passes (0 to 5) and maxRounds (1 to 10)', () => {
    const polish = (passes: number) => ({
      ...base(),
      stages: [{ id: 'p', type: 'polish', passes }],
    });
    expect(workflowSchema.safeParse(polish(5)).success).toBe(true);
    expect(workflowSchema.safeParse(polish(6)).success).toBe(false);
    const cap = (maxRounds: number) => ({
      ...base(),
      transitions: [{ from: 'a', to: 'b', on: ['done'], maxRounds }],
    });
    expect(workflowSchema.safeParse(cap(10)).success).toBe(true);
    expect(workflowSchema.safeParse(cap(11)).success).toBe(false);
    expect(workflowSchema.safeParse(cap(0)).success).toBe(false);
  });

  it('keeps the second phase: `parallel` and a `when` object', () => {
    const parsed = workflowSchema.parse({
      ...base(),
      parallel: [{ id: 'g', stages: ['test', 'dev'], join: 'any' }],
    });
    expect(parsed.parallel).toHaveLength(1);
    expect(
      workflowSchema.safeParse({
        ...base(),
        parallel: [{ id: 'g', stages: ['test'], join: 'all' }],
      }).success,
    ).toBe(false);
  });
});

describe('validateWorkflow on the files (SC-004)', () => {
  const invalid = readdirSync(join(FIXTURES, 'invalid')).filter((f) => f.endsWith('.yaml'));

  it('has a file for every code of the contract that a file can show', () => {
    const shown = new Set(
      invalid.map(
        (f) =>
          (JSON.parse(read('invalid', f.replace('.yaml', '.expected.json'))) as { code: string })
            .code,
      ),
    );
    for (const code of [
      'syntax',
      'duplicate-key',
      'alias',
      'version-missing',
      'version-newer',
      'schema',
      'unknown-ref',
      'too-many-agents',
      'missing-role',
      'same-agent-loop',
      'bad-outcome',
      'ambiguous-outcome',
      'unreachable',
      'no-end-reachable',
      'bad-end',
      'uncapped-cycle',
      'caps-differ',
      'cap-too-high',
      'free-expression',
      'too-large',
    ]) {
      expect(shown, code).toContain(code);
    }
  });

  it.each(invalid)(
    '%s is refused with the code, the line or the stage of its .expected.json',
    (file) => {
      const expected = JSON.parse(read('invalid', file.replace('.yaml', '.expected.json'))) as {
        code: string;
        line?: number;
        stage?: string;
      };
      const result = loadWorkflow(read('invalid', file));
      expect(result.workflow).toBeNull();
      const found = result.errors.filter((e) => e.code === expected.code);
      expect(found.length, JSON.stringify(result.errors)).toBeGreaterThan(0);
      if (expected.line !== undefined) expect(found.map((e) => e.line)).toContain(expected.line);
      if (expected.stage !== undefined) expect(found.map((e) => e.stage)).toContain(expected.stage);
      // Every error names a line or a stage (FR-009).
      for (const error of result.errors) {
        expect(error.line !== undefined || error.stage !== undefined, error.message).toBe(true);
      }
    },
  );

  it('refuses a file over 64 KiB with « too-large »', () => {
    const result = loadWorkflow(`${read('valid', 'default.yaml')}# ${'x'.repeat(70_000)}\n`);
    expect(result.errors.map((e) => e.code)).toEqual(['too-large']);
  });

  it.each(readdirSync(join(FIXTURES, 'valid')))('%s has no error', (file) => {
    const result = loadWorkflow(read('valid', file));
    expect(result.errors).toEqual([]);
    expect(result.workflow).not.toBeNull();
    expect(result.phase2.length > 0).toBe(file === 'phase2.yaml');
  });
});

describe('validateWorkflow on the rules', () => {
  it('accepts the capped loop test ⇄ dev', () => {
    expect(check(() => undefined).errors).toEqual([]);
  });

  it('refuses the loop without a ceiling: uncapped-cycle', () => {
    const v = check((w) => {
      for (const t of w.transitions) delete t.maxRounds;
    });
    expect(codes(v)).toContain('uncapped-cycle');
  });

  it('refuses two different ceilings into dev: caps-differ', () => {
    const v = check((w) => {
      const back = w.transitions.find((t) => t.from === 'pr');
      if (back) back.maxRounds = 2;
    });
    expect(codes(v)).toContain('caps-differ');
  });

  it('refuses the same key for dev and test: same-agent-loop', () => {
    const v = check((w) => {
      const test = w.stages.find((s) => s.id === 'test');
      if (test) test.agents = ['dev', 'tester'];
    });
    expect(codes(v)).toContain('same-agent-loop');
  });

  it('refuses 7 keys: too-many-agents', () => {
    const v = check((w) => {
      for (const k of 'abcd') w.agents[k] = { role: 'recap' };
    });
    expect(codes(v)).toContain('too-many-agents');
  });

  it('accepts 6 keys', () => {
    const v = check((w) => {
      for (const k of 'abc') w.agents[k] = { role: 'recap' };
    });
    expect(v.errors).toEqual([]);
  });

  it('holds `parallel` and a `when` object for the second phase only', () => {
    const v = check((w) => {
      w.parallel = [{ id: 'g', stages: ['test', 'dev'], join: 'all' }];
      const t = w.transitions[2];
      if (t) t.when = { label: 'urgent' };
    });
    expect(v.errors).toEqual([]);
    expect(v.phase2.map((i) => i.code)).toEqual(['phase2', 'phase2']);
    expect(v.workflow).not.toBeNull();
  });

  it('refuses a `when` string: free-expression', () => {
    const v = validateWorkflow({
      ...base(),
      transitions: [{ from: 'spec', to: 'test', on: ['ready'], when: 'round > 2' }],
    });
    expect(codes(v)).toContain('free-expression');
  });

  it('refuses version 2 without reading further: version-newer', () => {
    const v = validateWorkflow({ ...base(), version: 2 });
    expect(codes(v)).toEqual(['version-newer']);
    expect(v.errors[0]?.message).toContain('v2');
  });

  it('refuses a missing version, and an end that is a test stage', () => {
    const without: Record<string, unknown> = { ...base() };
    delete without.version;
    expect(codes(validateWorkflow(without))).toEqual(['version-missing']);
    expect(
      codes(
        check((w) => {
          w.ends = ['pr', 'polish'];
        }),
      ),
    ).toContain('bad-end');
  });

  it('refuses a stage the graph cannot reach, and one that leads to no end', () => {
    expect(
      codes(
        check((w) => {
          w.stages.push({ id: 'x', type: 'pr', agents: [] });
        }),
      ),
    ).toContain('unreachable');
    expect(
      codes(
        check((w) => {
          w.stages.push({ id: 'trap', type: 'dev', agents: ['dev'] });
          w.transitions.push({ from: 'pr', to: 'trap', on: ['conflicted'] });
        }),
      ),
    ).toContain('no-end-reachable');
  });

  it("refuses two transitions on one outcome, and an outcome that is not the stage's", () => {
    expect(
      codes(
        check((w) => {
          w.transitions.push({ from: 'spec', to: 'dev', on: ['ready'] });
        }),
      ),
    ).toContain('ambiguous-outcome');
    expect(
      codes(
        check((w) => {
          w.transitions[2] = { from: 'dev', to: 'test', on: ['accepted'] };
        }),
      ),
    ).toContain('bad-outcome');
  });

  it('refuses an unknown stage or agent, a missing role', () => {
    expect(
      codes(
        check((w) => {
          w.start = 'ghost';
        }),
      ),
    ).toContain('unknown-ref');
    expect(
      codes(
        check((w) => {
          const s = w.stages[0];
          if (s) s.agents = ['ghost'];
        }),
      ),
    ).toContain('unknown-ref');
    expect(
      codes(
        check((w) => {
          const s = w.stages[1];
          if (s) s.agents = [];
        }),
      ),
    ).toContain('missing-role');
  });
});

describe('defaultWorkflow (research R11)', () => {
  it('is the chain of 004 and 008 and passes validation', () => {
    const w = defaultWorkflow(defaultDeliverySettings());
    expect(validateWorkflow(w)).toMatchObject({ errors: [], phase2: [] });
    expect(w.stages.map((s) => s.type)).toEqual(['spec', 'test', 'dev', 'polish', 'pr']);
    expect(w.transitions.map((t) => `${t.from}>${t.to}`)).toEqual([
      'spec>test',
      'test>dev',
      'dev>test',
      'test>polish',
      'polish>pr',
      'pr>dev',
    ]);
    expect(w.start).toBe('spec');
    expect(w.ends).toEqual(['pr']);
    expect(Object.keys(w.agents)).toEqual(['spec', 'tester', 'dev']);
  });

  it('takes the ceiling, the passes, the brief and the merge mode of workspace.delivery', () => {
    const w = defaultWorkflow({
      auto: true,
      mergeMode: 'rebase',
      maxRounds: 5,
      polishPasses: 2,
      polishBrief: 'Noms.',
    });
    expect(w.transitions.filter((t) => t.maxRounds !== undefined).map((t) => t.maxRounds)).toEqual([
      5, 5,
    ]);
    expect(w.stages.find((s) => s.type === 'polish')).toMatchObject({
      passes: 2,
      instruction: 'Noms.',
    });
    expect(w.stages.find((s) => s.type === 'pr')).toMatchObject({ mergeMode: 'rebase' });
    expect(validateWorkflow(w).errors).toEqual([]);
  });

  it('equals itself once written and read', () => {
    const w = defaultWorkflow(defaultDeliverySettings());
    expect(workflowSchema.parse(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });
});

describe('ignoredLocal (US3 sc.6)', () => {
  it('lists the local settings that differ from the file', () => {
    const w = defaultWorkflow({
      auto: false,
      mergeMode: 'merge',
      maxRounds: 4,
      polishPasses: 1,
      polishBrief: 'a',
    });
    expect(ignoredLocal(defaultDeliverySettings(), w)).toEqual([
      'maxRounds',
      'polishPasses',
      'polishBrief',
      'mergeMode',
    ]);
  });
  it('lists nothing when the file says what the settings say', () => {
    expect(
      ignoredLocal(defaultDeliverySettings(), defaultWorkflow(defaultDeliverySettings())),
    ).toEqual([]);
  });
});

describe('equalWorkflows and nextStages', () => {
  it('ignores the order of the keys, not the order of the stages', () => {
    const a = base();
    const b = JSON.parse(JSON.stringify(a)) as Workflow;
    const reordered = {
      ends: b.ends,
      start: b.start,
      transitions: b.transitions,
      stages: b.stages,
      agents: b.agents,
      name: b.name,
      version: b.version,
    } as Workflow;
    expect(equalWorkflows(a, reordered)).toBe(true);
    const swapped = { ...a, stages: [...a.stages].reverse() };
    expect(equalWorkflows(a, swapped)).toBe(false);
  });

  it('gives the transitions that leave a stage', () => {
    const w = base();
    expect(nextStages(w, 'test')).toEqual([
      { to: 'dev', on: ['tests-written', 'defects'], maxRounds: 3 },
      { to: 'polish', on: ['accepted'] },
    ]);
    expect(nextStages(w, 'pr')).toHaveLength(1);
    expect(nextStages(w, 'nowhere')).toEqual([]);
  });
});

describe('machineCheck (FR-017)', () => {
  const cli = (id: string, status: TieredCli['status'] = 'installed'): TieredCli => ({
    id,
    status,
    modelTiers: [['claude-haiku-5-5'], ['claude-sonnet-5-5'], ['claude-opus-5-5']],
  });
  const profile = (maxModel: string | null): RoleProfile => ({
    cliId: 'claude-code',
    model: null,
    effort: null,
    maxModel,
    escalate: false,
  });
  const profiles = { dev: profile('claude-sonnet-5-5'), test: profile(null) };
  const wf = (agent: Workflow['agents'][string]): Workflow => ({
    ...base(),
    agents: { dev: agent },
  });

  it('says nothing about an agent with no model: the profile of its role decides', () => {
    expect(machineCheck(wf({ role: 'dev' }), [cli('claude-code')], profiles)).toEqual([]);
  });
  it('model-unavailable: a model outside the tiers', () => {
    const issues = machineCheck(
      wf({ role: 'dev', model: 'gpt-9' }),
      [cli('claude-code')],
      profiles,
    );
    expect(issues.map((i) => i.code)).toEqual(['model-unavailable']);
  });
  it('model-above-ceiling: above the maxModel of the role', () => {
    const issues = machineCheck(
      wf({ role: 'dev', model: 'claude-opus-5-5' }),
      [cli('claude-code')],
      profiles,
    );
    expect(issues.map((i) => i.code)).toEqual(['model-above-ceiling']);
  });
  it('accepts a model at or below the ceiling', () => {
    expect(
      machineCheck(wf({ role: 'dev', model: 'claude-sonnet-5-5' }), [cli('claude-code')], profiles),
    ).toEqual([]);
  });
  it('cli-missing: a CLI that is not installed, or not known', () => {
    for (const clis of [[cli('codex', 'missing')], [cli('claude-code')]]) {
      const issues = machineCheck(wf({ role: 'dev', cli: 'codex' }), clis, profiles);
      expect(issues.map((i) => i.code)).toEqual(['cli-missing']);
    }
  });
});

describe('outcomeOf (research R5)', () => {
  const TYPES = ['spec', 'design', 'test', 'dev', 'polish', 'pr', 'recap'] as const;
  type T = (typeof TYPES)[number];
  const delivery = (outcome: string) => ({ kind: 'delivery', delivery: { outcome } }) as const;
  // Every row of R5: [type, source, outcome]. The cross cases below derive from this table.
  const ROWS = [
    ['spec', { kind: 'issue', issueState: 'ready' }, 'ready'],
    ['design', { kind: 'mockup' }, 'done'],
    ['test', { kind: 'report', role: 'test', status: 'done' }, 'tests-written'],
    ['test', { kind: 'verdict', verdict: 'accepted' }, 'accepted'],
    ['test', { kind: 'verdict', verdict: 'defects' }, 'defects'],
    ['test', { kind: 'loop', loop: 'polishing' }, 'accepted'],
    ['test', { kind: 'loop', loop: 'accepted' }, 'accepted'],
    ['dev', { kind: 'report', role: 'dev', status: 'done' }, 'done'],
    ['recap', { kind: 'report', role: 'recap', status: 'done' }, 'done'],
    ['polish', { kind: 'loop', loop: 'accepted' }, 'done'],
    ['pr', delivery('merged'), 'merged'],
    ['pr', delivery('ci-red'), 'ci-red'],
    ['pr', delivery('tests-failed'), 'tests-failed'],
    ['pr', delivery('conflicted'), 'conflicted'],
    ['pr', delivery('user-refused'), 'user-refused'],
  ] as const;

  it.each(ROWS)('%s ← %j is %s', (type, source, outcome) => {
    expect(outcomeOf(type, source)).toBe(outcome);
  });

  it('gives null to every other stage type for each source of a row', () => {
    for (const [owner, source] of ROWS) {
      for (const type of TYPES as readonly T[]) {
        // `test` shares the loop notice and `accepted` with `polish`, by rows of their own.
        const given = ROWS.some(
          ([t, s]) => t === type && JSON.stringify(s) === JSON.stringify(source),
        );
        if (type === owner || given) continue;
        expect(outcomeOf(type, source), `${type} ← ${JSON.stringify(source)}`).toBeNull();
      }
    }
  });

  it.each([
    ['mockup', 'dev'],
    ['mockup', 'recap'],
    ['mockup', 'test'],
    ['mockup', 'polish'],
    ['mockup', 'pr'],
  ] as const)('a %s gives nothing to a %s stage', (_, type) => {
    expect(outcomeOf(type, { kind: 'mockup' })).toBeNull();
  });

  it('a done report of another role gives nothing to design, polish, recap, dev', () => {
    for (const role of ['spec', 'design', 'test', 'dev', 'recap', 'orchestrator'] as const) {
      for (const type of ['design', 'polish', 'recap', 'dev'] as const) {
        const own = (type === 'dev' && role === 'dev') || (type === 'recap' && role === 'recap');
        expect(outcomeOf(type, { kind: 'report', role, status: 'done' }), `${type}/${role}`).toBe(
          own ? 'done' : null,
        );
      }
    }
  });

  it('the loop moving to polishing or accepted gives accepted to test, done only to polish', () => {
    expect(outcomeOf('test', { kind: 'loop', loop: 'polishing' })).toBe('accepted');
    expect(outcomeOf('test', { kind: 'loop', loop: 'accepted' })).toBe('accepted');
    expect(outcomeOf('polish', { kind: 'loop', loop: 'polishing' })).toBeNull();
    for (const loop of ['running', 'delivering', 'merged', 'escalated', 'closed'] as const) {
      for (const type of TYPES) {
        expect(outcomeOf(type, { kind: 'loop', loop }), `${type}/${loop}`).toBeNull();
      }
    }
  });

  it.each([
    ['pr', delivery('refused')],
    ['pr', delivery('dropped')],
    ['pr', delivery('pr-opened')],
    ['pr', delivery('escalated')],
    ['pr', { kind: 'delivery' }],
    ['dev', { kind: 'usage-save' }],
    ['dev', { kind: 'usage-paused' }],
    ['dev', { kind: 'usage-resumed' }],
    ['test', { kind: 'turn-finished' }],
    ['dev', { kind: 'report', role: 'dev', status: 'blocked' }],
    ['recap', { kind: 'report', role: 'recap', status: 'blocked' }],
    ['test', { kind: 'report', role: 'test', status: 'blocked' }],
    ['test', { kind: 'report', role: 'dev', status: 'done' }],
    ['dev', { kind: 'issue', issueState: 'proposed' }],
    ['spec', { kind: 'issue', issueState: 'proposed' }],
    ['test', { kind: 'verdict' }],
  ] as const)('%s ← %j gives no outcome', (type, source) => {
    expect(outcomeOf(type, source)).toBeNull();
  });

  it('gives none to a stage of another type', () => {
    expect(outcomeOf('dev', { kind: 'verdict', verdict: 'accepted' })).toBeNull();
    expect(outcomeOf('dev', { kind: 'loop', loop: 'accepted' })).toBeNull();
    expect(outcomeOf('dev', { kind: 'report', role: 'test', status: 'done' })).toBeNull();
    expect(outcomeOf('spec', { kind: 'mockup' })).toBeNull();
  });
});

describe('Run and workflow state (data-model)', () => {
  const now = '2026-11-13T10:00:00.000Z';
  const run = (over: object = {}) => ({
    issueId: '0001-a',
    oid: 'default',
    workflow: base(),
    stage: 'spec',
    status: 'active',
    startedAt: now,
    updatedAt: now,
    ...over,
  });
  it('gives the defaults of a run', () => {
    expect(runSchema.parse(run())).toMatchObject({
      bindings: {},
      entries: {},
      lastMessageId: null,
      history: [],
      reason: null,
    });
  });
  it('takes a blob id or default as oid, and refuses another', () => {
    expect(runSchema.safeParse(run({ oid: 'a'.repeat(40) })).success).toBe(true);
    expect(runSchema.safeParse(run({ oid: 'main' })).success).toBe(false);
  });
  it('keeps at most 50 history entries and knows its four statuses', () => {
    const entry = { at: now, from: 'a', to: 'b', outcome: 'done' };
    expect(runSchema.safeParse(run({ history: Array(50).fill(entry) })).success).toBe(true);
    expect(runSchema.safeParse(run({ history: Array(51).fill(entry) })).success).toBe(false);
    for (const status of ['active', 'waiting-user', 'finished', 'refused']) {
      expect(runSchema.safeParse(run({ status })).success).toBe(true);
    }
    expect(runSchema.safeParse(run({ status: 'paused' })).success).toBe(false);
  });
  it('has no file, no error and no read by default', () => {
    expect(defaultWorkflowState()).toEqual({ lastValid: null, error: null, readAt: null });
  });
});
