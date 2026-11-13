import { z } from 'zod';
import type { DeliverySettings } from './delivery';
import { MAX_POLISH, MAX_POLISH_BRIEF, MAX_ROUNDS_LIMIT, mergeModeSchema } from './delivery';
import type { ExchangeKind } from './exchanges';
import type { Issue, RoleProfile } from './model';
import { isoDate, type Role } from './primitives';
import type { TieredCli } from './roles';
import { beyondCeiling, tierOf } from './roles';

// 010 data-model.md, research R4 to R7, R11 and R18 — the workflow of the delivery as a graph: the
// schemas, the pure rules (outcomes, validation, default) and nothing that touches a file or a process.

export const WORKFLOW_PATH = '.pact/workflow.yaml';
export const WORKFLOW_FORMAT = 1;
export const MAX_WORKFLOW_BYTES = 65_536;
export const MAX_STAGES = 20;
export const MAX_STAGE_INSTRUCTION = MAX_POLISH_BRIEF;
export const MAX_RUN_HISTORY = 50;
export const MAX_AGENTS = 6;

export const STAGE_TYPES = ['spec', 'design', 'dev', 'test', 'polish', 'pr', 'recap'] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const OUTCOMES = [
  'ready',
  'done',
  'tests-written',
  'accepted',
  'defects',
  'merged',
  'ci-red',
  'tests-failed',
  'conflicted',
  'user-refused',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** R5 — the closed list of outcomes of each type of stage. */
const OUTCOMES_OF: Record<StageType, readonly Outcome[]> = {
  spec: ['ready'],
  design: ['done'],
  test: ['tests-written', 'accepted', 'defects'],
  dev: ['done'],
  polish: ['done'],
  pr: ['merged', 'ci-red', 'tests-failed', 'conflicted', 'user-refused'],
  recap: ['done'],
};

export const outcomesOf = (type: StageType): readonly Outcome[] => OUTCOMES_OF[type];

/** The outcome that ends a stage which is an arrival. */
export const terminalOutcome = (type: StageType): Outcome =>
  type === 'pr' ? 'merged' : type === 'spec' ? 'ready' : 'done';

/** R4 — the roles each type of stage needs, one agent each. */
const ROLES_OF: Record<StageType, readonly Role[]> = {
  spec: ['spec'],
  design: ['design'],
  test: ['test'],
  dev: ['dev'],
  polish: ['dev', 'test'],
  pr: [],
  recap: ['recap'],
};

const KEY = /^[a-z][a-z0-9-]{0,30}$/;
const WORKFLOW_NAME = /^[a-z0-9-]{1,60}$/;

export const workflowAgentSchema = z.strictObject({
  role: z.enum(['spec', 'design', 'dev', 'test', 'recap']),
  cli: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;

const coordinate = z.int().min(0);

export const stageSchema = z
  .strictObject({
    id: z.string().regex(KEY),
    type: z.enum(STAGE_TYPES),
    agents: z.array(z.string().regex(KEY)).default([]),
    instruction: z.string().max(MAX_STAGE_INSTRUCTION).optional(),
    passes: z.int().min(0).max(MAX_POLISH).optional(),
    mergeMode: mergeModeSchema.optional(),
    position: z.strictObject({ x: coordinate, y: coordinate }).optional(),
  })
  .superRefine((stage, ctx) => {
    if (stage.passes !== undefined && stage.type !== 'polish') {
      ctx.addIssue({
        code: 'custom',
        path: ['passes'],
        message: 'passes : étape polish seulement',
      });
    }
    if (stage.mergeMode !== undefined && stage.type !== 'pr') {
      ctx.addIssue({
        code: 'custom',
        path: ['mergeMode'],
        message: 'mergeMode : étape pr seulement',
      });
    }
  })
  .transform((stage) => ({
    ...stage,
    ...(stage.type === 'polish' ? { passes: stage.passes ?? 0 } : {}),
    ...(stage.type === 'pr' ? { mergeMode: stage.mergeMode ?? ('squash' as const) } : {}),
  }));
export type Stage = z.infer<typeof stageSchema>;

export const transitionSchema = z.strictObject({
  from: z.string().regex(KEY),
  to: z.string().regex(KEY),
  on: z.array(z.string()).min(1),
  maxRounds: z.int().min(1).max(MAX_ROUNDS_LIMIT).optional(),
  /** Second phase: kept, never run. */
  when: z.record(z.string(), z.unknown()).optional(),
});
export type Transition = z.infer<typeof transitionSchema>;

export const parallelGroupSchema = z.strictObject({
  id: z.string().regex(KEY),
  stages: z.array(z.string().regex(KEY)).min(2),
  join: z.enum(['all', 'any']),
});
export type ParallelGroup = z.infer<typeof parallelGroupSchema>;

export const workflowSchema = z.strictObject({
  version: z.int().min(1),
  name: z.string().regex(WORKFLOW_NAME),
  agents: z.record(z.string().regex(KEY), workflowAgentSchema),
  stages: z.array(stageSchema).min(1).max(MAX_STAGES),
  transitions: z.array(transitionSchema),
  start: z.string().regex(KEY),
  ends: z.array(z.string().regex(KEY)).min(1),
  parallel: z.array(parallelGroupSchema).optional(),
});
export type Workflow = z.infer<typeof workflowSchema>;

// ---------------------------------------------------------------------------------- state

export const RUN_STATUSES = ['active', 'waiting-user', 'finished', 'refused'] as const;

export const runHistorySchema = z.object({
  at: isoDate,
  from: z.string(),
  to: z.string(),
  outcome: z.string(),
});

/** `workspace.runs[]`: one run per issue, on the version of the workflow it started with (R8). */
export const runSchema = z.object({
  issueId: z.string().min(1),
  oid: z.union([z.literal('default'), z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)]),
  workflow: workflowSchema,
  stage: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  bindings: z.record(z.string(), z.uuid()).default({}),
  entries: z.record(z.string(), z.int().min(0)).default({}),
  lastMessageId: z.uuid().nullable().default(null),
  history: z.array(runHistorySchema).max(MAX_RUN_HISTORY).default([]),
  reason: z.string().nullable().default(null),
  startedAt: isoDate,
  updatedAt: isoDate,
});
export type Run = z.infer<typeof runSchema>;

/** `workspace.workflow`: what the main branch says (R10). */
export const workflowStateSchema = z.object({
  lastValid: z
    .object({ oid: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), workflow: workflowSchema })
    .nullable()
    .default(null),
  error: z
    .object({
      message: z.string(),
      line: z.int().positive().optional(),
      oid: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    })
    .nullable()
    .default(null),
  readAt: isoDate.nullable().default(null),
});
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export const defaultWorkflowState = (): WorkflowState => workflowStateSchema.parse({});

// ------------------------------------------------------------------------------ validation

export const ISSUE_CODES = [
  'syntax',
  'duplicate-key',
  'alias',
  'too-large',
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
  'phase2',
  'model-unavailable',
  'model-above-ceiling',
  'cli-missing',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export type WorkflowIssue = {
  code: IssueCode;
  message: string;
  stage?: string;
  line?: number;
  column?: number;
};
export type Validation = {
  workflow: Workflow | null;
  errors: WorkflowIssue[];
  phase2: WorkflowIssue[];
};

/** The line of each node of a file, by its path (`transitions.2.on.0`), given by `parseWorkflow`. */
export type LineMap = Readonly<Record<string, number>>;

/** The line of a path, else of its nearest ancestor. */
function lineOf(lines: LineMap, path: string): number | undefined {
  for (let at = path; ;) {
    const line = lines[at];
    if (line !== undefined) return line;
    const cut = at.lastIndexOf('.');
    if (cut < 0) return lines[''] ?? undefined;
    at = at.slice(0, cut);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const quoted = (id: string) => `« ${id} »`;

/**
 * R6 — every rule of the first phase, in order. `data` is what the parser read (never trusted);
 * `lines` gives the line of each node so that every error names a line or a stage (FR-009).
 */
export function validateWorkflow(data: unknown, lines: LineMap = {}): Validation {
  const errors: WorkflowIssue[] = [];
  const phase2: WorkflowIssue[] = [];
  const at = (path: string, issue: Omit<WorkflowIssue, 'line'>): WorkflowIssue => {
    const line = lineOf(lines, path);
    return line === undefined ? issue : { ...issue, line };
  };
  const fail = (): Validation => ({ workflow: null, errors, phase2 });

  if (!isRecord(data)) {
    errors.push(at('', { code: 'schema', message: 'Le fichier doit être une table YAML' }));
    return fail();
  }
  // 2. the version, before anything else can be trusted
  if (!('version' in data)) {
    errors.push({
      code: 'version-missing',
      message: 'version du format absente (ligne 1)',
      line: 1,
    });
    return fail();
  }
  if (
    typeof data.version === 'number' &&
    Number.isInteger(data.version) &&
    data.version > WORKFLOW_FORMAT
  ) {
    errors.push(
      at('version', {
        code: 'version-newer',
        message: `format plus récent (v${String(data.version)}) : mets PACT à jour`,
      }),
    );
    return fail();
  }
  if (isRecord(data.agents) && Object.keys(data.agents).length > MAX_AGENTS) {
    errors.push(
      at('agents', {
        code: 'too-many-agents',
        message: `${String(Object.keys(data.agents).length)} agents : ${String(MAX_AGENTS)} au plus`,
      }),
    );
  }
  // Free expressions have their own message: a string where a structure is expected.
  const transitionsIn = Array.isArray(data.transitions) ? data.transitions : [];
  transitionsIn.forEach((transition: unknown, index) => {
    if (isRecord(transition) && typeof transition.when === 'string') {
      errors.push(
        at(`transitions.${String(index)}.when`, {
          code: 'free-expression',
          message: `Ligne ${String(lineOf(lines, `transitions.${String(index)}.when`) ?? '?')} : une condition doit être structurée, pas une expression`,
        }),
      );
    }
  });
  if (errors.some((issue) => issue.code === 'free-expression')) return fail();

  // 3. the schema
  const parsed = workflowSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.');
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) {
          errors.push(
            at(path === '' ? key : `${path}.${key}`, {
              code: 'schema',
              message: `clé inconnue \`${key}\``,
            }),
          );
        }
      } else if (issue.path.at(-1) === 'maxRounds' && issue.code === 'too_big') {
        const line = lineOf(lines, path);
        errors.push(
          at(path, {
            code: 'cap-too-high',
            message: `Ligne ${String(line ?? '?')} : ${String(MAX_ROUNDS_LIMIT)} tours au plus`,
          }),
        );
      } else {
        errors.push(
          at(path, { code: 'schema', message: `${path || 'fichier'} : ${issue.message}` }),
        );
      }
    }
    return fail();
  }
  const workflow = parsed.data;
  const typeOf = new Map(workflow.stages.map((stage) => [stage.id, stage.type]));

  const ids = workflow.stages.map((stage) => stage.id);
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index) {
      errors.push(
        at(`stages.${String(index)}`, {
          code: 'schema',
          message: `étape ${quoted(id)} en double`,
          stage: id,
        }),
      );
    }
  });

  // 4. references
  const unknownStage = (id: string, path: string) => {
    if (typeOf.has(id)) return;
    errors.push(
      at(path, {
        code: 'unknown-ref',
        message: `Ligne ${String(lineOf(lines, path) ?? '?')} : étape ${quoted(id)} inconnue`,
      }),
    );
  };
  workflow.stages.forEach((stage, i) => {
    stage.agents.forEach((key, j) => {
      if (key in workflow.agents) return;
      errors.push(
        at(`stages.${String(i)}.agents.${String(j)}`, {
          code: 'unknown-ref',
          message: `Ligne ${String(lineOf(lines, `stages.${String(i)}.agents.${String(j)}`) ?? '?')} : agent ${quoted(key)} inconnu`,
          stage: stage.id,
        }),
      );
    });
  });
  workflow.transitions.forEach((t, i) => {
    unknownStage(t.from, `transitions.${String(i)}.from`);
    unknownStage(t.to, `transitions.${String(i)}.to`);
  });
  unknownStage(workflow.start, 'start');
  workflow.ends.forEach((id, i) => {
    unknownStage(id, `ends.${String(i)}`);
  });
  workflow.parallel?.forEach((group, i) => {
    group.stages.forEach((id, j) => {
      unknownStage(id, `parallel.${String(i)}.stages.${String(j)}`);
    });
  });
  if (errors.some((issue) => issue.code === 'unknown-ref')) return fail();

  // 5. agents: the roles of each type, and one agent that is not both dev and tester
  for (const stage of workflow.stages) {
    for (const role of ROLES_OF[stage.type]) {
      const has = stage.agents.some((key) => workflow.agents[key]?.role === role);
      if (!has) {
        errors.push({
          code: 'missing-role',
          message: `Étape ${quoted(stage.id)} : il faut un agent ${role}`,
          stage: stage.id,
          ...(lineOf(lines, `stages.${String(workflow.stages.indexOf(stage))}`) !== undefined
            ? { line: lineOf(lines, `stages.${String(workflow.stages.indexOf(stage))}`) as number }
            : {}),
        });
      }
    }
  }
  for (const t of workflow.transitions) {
    const a = workflow.stages.find((stage) => stage.id === t.from);
    const b = workflow.stages.find((stage) => stage.id === t.to);
    if (!a || !b) continue;
    const pair = [a, b].sort((x, y) => x.type.localeCompare(y.type));
    if (pair[0]?.type !== 'dev' || pair[1]?.type !== 'test') continue;
    const dev = pair[0];
    const test = pair[1];
    if (dev.agents.some((key) => test.agents.includes(key))) {
      if (!errors.some((e) => e.code === 'same-agent-loop' && e.stage === test.id)) {
        errors.push({
          code: 'same-agent-loop',
          message: `Étapes ${quoted(dev.id)} et ${quoted(test.id)} : un même agent ne peut pas être dev et testeur`,
          stage: test.id,
        });
      }
    }
  }

  // 6. outcomes
  workflow.transitions.forEach((t, i) => {
    const type = typeOf.get(t.from);
    if (!type || t.when !== undefined) return;
    t.on.forEach((value, j) => {
      if ((OUTCOMES_OF[type] as readonly string[]).includes(value)) return;
      const path = `transitions.${String(i)}.on.${String(j)}`;
      errors.push(
        at(path, {
          code: 'bad-outcome',
          message: `Ligne ${String(lineOf(lines, path) ?? '?')} : « ${value} » n'est pas un résultat de ${type} (possibles : ${OUTCOMES_OF[type].join(', ')})`,
          stage: t.from,
        }),
      );
    });
  });
  const taken = new Set<string>();
  for (const t of workflow.transitions) {
    if (t.when !== undefined) continue;
    for (const value of t.on) {
      const key = `${t.from}\u0000${value}`;
      if (taken.has(key)) {
        if (!errors.some((e) => e.code === 'ambiguous-outcome' && e.stage === t.from)) {
          errors.push({
            code: 'ambiguous-outcome',
            message: `Étape ${quoted(t.from)} : deux transitions sur « ${value} »`,
            stage: t.from,
          });
        }
      }
      taken.add(key);
    }
  }

  // 7. the graph
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const t of workflow.transitions) {
    next.set(t.from, [...(next.get(t.from) ?? []), t.to]);
    prev.set(t.to, [...(prev.get(t.to) ?? []), t.from]);
  }
  const reach = (from: readonly string[], edges: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>(from);
    const todo = [...from];
    for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
      for (const to of edges.get(id) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          todo.push(to);
        }
      }
    }
    return seen;
  };
  const fromStart = reach([workflow.start], next);
  const toEnd = reach(workflow.ends, prev);
  workflow.stages.forEach((stage, index) => {
    const line = lineOf(lines, `stages.${String(index)}`);
    const where = line === undefined ? {} : { line };
    if (!fromStart.has(stage.id)) {
      errors.push({
        code: 'unreachable',
        message: `Étape ${quoted(stage.id)} isolée : aucun chemin depuis ${quoted(workflow.start)}`,
        stage: stage.id,
        ...where,
      });
    } else if (!toEnd.has(stage.id)) {
      errors.push({
        code: 'no-end-reachable',
        message: `Étape ${quoted(stage.id)} : aucune arrivée atteignable`,
        stage: stage.id,
        ...where,
      });
    }
  });
  workflow.ends.forEach((id, i) => {
    const type = typeOf.get(id);
    if (type === 'test' || type === 'polish') {
      errors.push(
        at(`ends.${String(i)}`, {
          code: 'bad-end',
          message: `Ligne ${String(lineOf(lines, `ends.${String(i)}`) ?? '?')} : l'étape ${quoted(id)} (${type}) ne peut pas être une arrivée`,
          stage: id,
        }),
      );
    }
  });

  // 8. the loops: every cycle holds a capped transition, and the caps into a stage agree
  const uncapped = workflow.transitions.filter((t) => t.maxRounds === undefined);
  const cycle = findCycle(
    workflow.stages.map((stage) => stage.id),
    uncapped.map((t) => [t.from, t.to] as const),
  );
  if (cycle) {
    const loop = cycleFrom(
      cycle,
      workflow.stages.map((stage) => stage.id),
    );
    errors.push({
      code: 'uncapped-cycle',
      message: `Boucle ${loop.join(' → ')} → ${loop[0] ?? ''} sans nombre maximum de tours`,
      stage: loop[0] ?? '',
    });
  }
  const caps = new Map<string, Set<number>>();
  for (const t of workflow.transitions) {
    if (t.maxRounds === undefined) continue;
    caps.set(t.to, (caps.get(t.to) ?? new Set()).add(t.maxRounds));
  }
  for (const [stage, values] of caps) {
    if (values.size > 1) {
      const [a, b] = [...values];
      errors.push({
        code: 'caps-differ',
        message: `Étape ${quoted(stage)} : plafonds différents (${String(a)} et ${String(b)})`,
        stage,
      });
    }
  }

  // 9. the second phase
  workflow.parallel?.forEach((group, i) =>
    phase2.push(
      at(`parallel.${String(i)}`, {
        code: 'phase2',
        message: `Étape parallèle ou condition (ligne ${String(lineOf(lines, `parallel.${String(i)}`) ?? '?')}) : prévue en seconde phase, ce workflow ne peut pas s'exécuter`,
        stage: group.id,
      }),
    ),
  );
  workflow.transitions.forEach((t, i) => {
    if (t.when === undefined) return;
    phase2.push(
      at(`transitions.${String(i)}.when`, {
        code: 'phase2',
        message: `Étape parallèle ou condition (ligne ${String(lineOf(lines, `transitions.${String(i)}.when`) ?? '?')}) : prévue en seconde phase, ce workflow ne peut pas s'exécuter`,
        stage: t.from,
      }),
    );
  });

  return errors.length > 0 ? fail() : { workflow, errors, phase2 };
}

/** A cycle of the graph, as the stages it goes through (depth-first search), or `null`. */
function findCycle(
  nodes: readonly string[],
  edges: readonly (readonly [string, string])[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const [from, to] of edges) out.set(from, [...(out.get(from) ?? []), to]);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 'open');
    stack.push(id);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 'open') return stack.slice(stack.indexOf(to));
      if (!state.has(to)) {
        const found = visit(to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of nodes) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** The cycle written from its first stage in the file. */
function cycleFrom(cycle: string[], order: readonly string[]): string[] {
  const first = cycle.reduce((best, id) => (order.indexOf(id) < order.indexOf(best) ? id : best));
  const at = cycle.indexOf(first);
  return [...cycle.slice(at), ...cycle.slice(0, at)];
}

// ------------------------------------------------------------------------------- machine

/**
 * R6 / FR-017 — what is wrong with the workflow on THIS machine: the CLI of an agent is not installed,
 * its model is unknown to the CLI or above the ceiling of its role. The file is never touched.
 */
export function machineCheck(
  workflow: Workflow,
  clis: readonly TieredCli[],
  profiles: Partial<Record<Role, RoleProfile>>,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  for (const [key, agent] of Object.entries(workflow.agents)) {
    const profile = profiles[agent.role];
    const cliId = agent.cli ?? profile?.cliId;
    if (agent.cli !== undefined) {
      const cli = clis.find((candidate) => candidate.id === agent.cli);
      if (cli?.status !== 'installed') {
        issues.push({
          code: 'cli-missing',
          message: `Agent ${quoted(key)} : ${agent.cli} n'est pas installé sur cette machine`,
        });
        continue;
      }
    }
    // No model: the profile of the role decides (FR-017).
    if (agent.model === undefined || cliId === undefined) continue;
    const tiers = clis.find((candidate) => candidate.id === cliId)?.modelTiers ?? [];
    if (tiers.length === 0) continue;
    if (tierOf(agent.model, tiers) < 0) {
      issues.push({
        code: 'model-unavailable',
        message: `Agent ${quoted(key)} : modèle ${quoted(agent.model)} absent de ${cliId} sur cette machine`,
      });
    } else if (beyondCeiling(agent.model, profile?.maxModel ?? null, tiers)) {
      issues.push({
        code: 'model-above-ceiling',
        message: `Agent ${quoted(key)} : ${quoted(agent.model)} dépasse le plafond du rôle ${agent.role} (${profile?.maxModel ?? ''})`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------- default

/** R11 — the workflow of a project without file: the chain of 004 and 008, with the settings of 008. */
export function defaultWorkflow(delivery: DeliverySettings): Workflow {
  const cap = delivery.maxRounds;
  return {
    version: WORKFLOW_FORMAT,
    name: 'livraison',
    agents: {
      spec: { role: 'spec' },
      tester: { role: 'test' },
      dev: { role: 'dev' },
    },
    stages: [
      { id: 'spec', type: 'spec', agents: ['spec'] },
      { id: 'test', type: 'test', agents: ['tester'] },
      { id: 'dev', type: 'dev', agents: ['dev'] },
      {
        id: 'polish',
        type: 'polish',
        agents: ['dev', 'tester'],
        passes: delivery.polishPasses,
        ...(delivery.polishBrief === '' ? {} : { instruction: delivery.polishBrief }),
      },
      { id: 'pr', type: 'pr', agents: [], mergeMode: delivery.mergeMode },
    ],
    transitions: [
      { from: 'spec', to: 'test', on: ['ready'] },
      { from: 'test', to: 'dev', on: ['tests-written', 'defects'], maxRounds: cap },
      { from: 'dev', to: 'test', on: ['done'] },
      { from: 'test', to: 'polish', on: ['accepted'] },
      { from: 'polish', to: 'pr', on: ['done'] },
      {
        from: 'pr',
        to: 'dev',
        on: ['ci-red', 'tests-failed', 'conflicted', 'user-refused'],
        maxRounds: cap,
      },
    ],
    start: 'spec',
    ends: ['pr'],
  };
}

export type IgnoredSetting = 'maxRounds' | 'polishPasses' | 'polishBrief' | 'mergeMode';

/** US3 sc.6 — the settings of 008 that the file overrides with another value. */
export function ignoredLocal(delivery: DeliverySettings, workflow: Workflow): IgnoredSetting[] {
  const ignored: IgnoredSetting[] = [];
  const cap = workflow.transitions.find(
    (t) => t.to === 'dev' && t.maxRounds !== undefined,
  )?.maxRounds;
  if (cap !== undefined && cap !== delivery.maxRounds) ignored.push('maxRounds');
  const polish = workflow.stages.find((stage) => stage.type === 'polish');
  if (polish) {
    if ((polish.passes ?? 0) !== delivery.polishPasses) ignored.push('polishPasses');
    if ((polish.instruction ?? '') !== delivery.polishBrief) ignored.push('polishBrief');
  }
  const pr = workflow.stages.find((stage) => stage.type === 'pr');
  if (pr && (pr.mergeMode ?? 'squash') !== delivery.mergeMode) ignored.push('mergeMode');
  return ignored;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};

/** Same graph: the order of the keys does not count, the order of the stages and transitions does. */
export const equalWorkflows = (a: Workflow, b: Workflow): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export type NextStage = { to: string; on: string[]; maxRounds?: number };

/** The transitions that leave a stage: where it may go, and on which outcomes. */
export function nextStages(workflow: Workflow, stage: string): NextStage[] {
  return workflow.transitions
    .filter((t) => t.from === stage)
    .map((t) => ({
      to: t.to,
      on: t.on,
      ...(t.maxRounds === undefined ? {} : { maxRounds: t.maxRounds }),
    }));
}

// -------------------------------------------------------------------------------- outcomeOf

type IssueState = Issue['state'];
export type DeliveryOutcomeName = string;

/** What `outcomeOf` reads of a message of the journal of 007, or of a change of an issue. */
export type OutcomeSource = {
  kind: ExchangeKind | 'issue';
  /** `issue`: the state the issue has just taken. */
  issueState?: IssueState;
  /** `report`: the role of the sender. */
  role?: Role;
  /** `report`: its status. */
  status?: 'done' | 'blocked' | 'defects';
  /** `verdict`: what the tester decided. */
  verdict?: 'accepted' | 'defects';
  /** `loop`: the state the loop has just taken. */
  loop?: 'running' | 'polishing' | 'accepted' | 'delivering' | 'merged' | 'escalated' | 'closed';
  /** `delivery`: the outcome of the request. */
  delivery?: { outcome: DeliveryOutcomeName };
};

const DELIVERY_RESULTS: Record<string, Outcome> = {
  merged: 'merged',
  'ci-red': 'ci-red',
  'tests-failed': 'tests-failed',
  conflicted: 'conflicted',
  'user-refused': 'user-refused',
};

/**
 * R5 — the outcome that a message gives to a stage of this type, or `null`: not an outcome of this
 * stage. `refused` and `dropped` of 008 leave the PR stage as it is, and the states of 009 never count.
 */
export function outcomeOf(type: StageType, source: OutcomeSource): Outcome | null {
  const outcome = ((): Outcome | null => {
    switch (source.kind) {
      case 'issue':
        return source.issueState === 'ready' ? 'ready' : null;
      case 'mockup':
        return 'done';
      case 'report':
        if (source.status !== 'done') return null;
        if (source.role === 'test') return 'tests-written';
        return source.role === 'dev' || source.role === 'recap' ? 'done' : null;
      case 'verdict':
        return source.verdict ?? null;
      case 'loop':
        return source.loop === 'accepted' ? 'done' : null;
      case 'delivery':
        return (source.delivery && DELIVERY_RESULTS[source.delivery.outcome]) ?? null;
      default:
        return null;
    }
  })();
  if (outcome === null) return null;
  // The loop notice « accepted » ends the polish stage only; the verdict `accepted` ends the test.
  if (source.kind === 'loop' && type !== 'polish') return null;
  if (source.kind === 'report' && source.role === 'test' && type !== 'test') return null;
  return OUTCOMES_OF[type].includes(outcome) ? outcome : null;
}
