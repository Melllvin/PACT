import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDeliverySettings } from '../../../src/shared/delivery';
import {
  defaultWorkflow,
  equalWorkflows,
  validateWorkflow,
  workflowSchema,
  type Workflow,
} from '../../../src/shared/workflow';
import { loadWorkflow, parseWorkflow, writeWorkflow } from '../../../src/shared/workflow-yaml';

// 010 T007 — reading with lines, and writing without loss (research R3, R13; SC-003, SC-005).

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'workflows', 'valid');
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml'));
const text = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const model = (t: string): Workflow => {
  const { workflow } = loadWorkflow(t);
  if (!workflow) throw new Error('valid file expected');
  return workflow;
};

describe('parseWorkflow', () => {
  it('gives the line of every node', () => {
    const { lines, errors } = parseWorkflow(text('default.yaml'));
    expect(errors).toEqual([]);
    expect(lines['version']).toBe(2);
    expect(lines['stages.0']).toBe(9);
    expect(lines['transitions.1']).toBe(16);
    expect(lines['transitions.1.maxRounds']).toBe(16);
    expect(lines['ends.0']).toBe(22);
  });

  it('gives the line of a node written on several lines', () => {
    const { lines } = parseWorkflow(text('free-order.yaml'));
    expect(lines['transitions.1.on']).toBe(11);
    expect(lines['transitions.1.on.1']).toBe(13);
  });

  it.each([
    ['an anchor', 'agents:\n  a: &x { role: dev }\n', 'alias', 2],
    ['an alias', 'a: &x 1\nb: *x\n', 'alias', 1],
    ['a tag', 'name: !custom x\n', 'alias', 1],
    ['a duplicate key', 'version: 1\nversion: 2\n', 'duplicate-key', 2],
    [
      'a conflict marker',
      'version: 1\n<<<<<<< HEAD\nname: a\n=======\nname: b\n>>>>>>> x\n',
      'syntax',
      2,
    ],
    ['a syntax error', 'a: [1, 2\nb: 3\n', 'syntax', undefined],
  ])('refuses %s with its line', (_label, source, code, line) => {
    const { errors } = parseWorkflow(source);
    expect(errors[0]?.code).toBe(code);
    if (line !== undefined) expect(errors[0]?.line).toBe(line);
    else expect(errors[0]?.line).toBeGreaterThan(0);
  });

  it('refuses more than 64 KiB', () => {
    expect(parseWorkflow(`a: 1\n# ${'x'.repeat(65_536)}\n`).errors[0]?.code).toBe('too-large');
  });

  it('reads multi-byte text by bytes, not characters', () => {
    expect(parseWorkflow(`# ${'é'.repeat(33_000)}\na: 1\n`).errors[0]?.code).toBe('too-large');
  });

  it('is what loadWorkflow checks first', () => {
    expect(loadWorkflow('version: 1\nversion: 2\n').errors[0]?.code).toBe('duplicate-key');
    expect(
      validateWorkflow(
        parseWorkflow(text('default.yaml')).data,
        parseWorkflow(text('default.yaml')).lines,
      ).errors,
    ).toEqual([]);
  });
});

describe('writeWorkflow keeps what did not change (SC-003)', () => {
  it.each(files)('%s: write(parse(t)) equals t, byte for byte', (file) => {
    const t = text(file);
    expect(writeWorkflow(t, model(t))).toBe(t);
  });
});

describe('writeWorkflow touches only what changed (SC-005)', () => {
  const lineDiff = (a: string, b: string) => {
    const x = a.split('\n');
    const y = b.split('\n');
    return x.flatMap((line, i) => (line === y[i] ? [] : [i + 1]));
  };

  it('a new instruction changes only its line, comments and second-phase nodes intact', () => {
    const t = text('phase2.yaml');
    const w = model(t);
    w.stages = w.stages.map((s) => (s.id === 'dev' ? { ...s, instruction: 'Petits pas.' } : s));
    const out = writeWorkflow(t, w);
    const changed = lineDiff(t, out);
    expect(changed).toHaveLength(1);
    expect(out.split('\n')[(changed[0] ?? 1) - 1]).toContain('instruction: Petits pas.');
    expect(out).toContain('when: { label: urgent }');
    expect(out).toContain('parallel:');
    expect(model(out).parallel).toEqual(w.parallel);
    expect(equalWorkflows(model(out), w)).toBe(true);
  });

  it('keeps the comments and the free order of a hand-written file', () => {
    const t = text('free-order.yaml');
    const w = model(t);
    const test = w.transitions.find((x) => x.from === 'test' && x.to === 'dev');
    if (test) test.maxRounds = 5;
    const out = writeWorkflow(t, w);
    expect(out).toContain('maxRounds: 5 # trois tours');
    expect(out).toContain('# la boucle');
    expect(out.startsWith('# Commentaires et ordre libres')).toBe(true);
    expect(lineDiff(t, out)).toHaveLength(1);
  });

  it('changes a list in place and a model of an agent', () => {
    const t = text('default.yaml');
    const w = model(t);
    w.ends = ['pr'];
    const dev = w.agents['dev'];
    if (dev) dev.model = 'claude-sonnet-5-5';
    const out = writeWorkflow(t, w);
    expect(model(out).agents['dev']?.model).toBe('claude-sonnet-5-5');
    expect(lineDiff(t, out)).toHaveLength(1);
  });

  it('adds a stage and its transitions at the end of their lists, and removes one', () => {
    const t = text('default.yaml');
    const w = model(t);
    const inserted: Workflow = {
      ...w,
      agents: { ...w.agents, scribe: { role: 'recap' } },
      stages: [
        ...w.stages,
        { id: 'recap', type: 'recap', agents: ['scribe'], instruction: 'Résume.' },
      ],
      transitions: [...w.transitions, { from: 'pr', to: 'recap', on: ['merged'] }],
      ends: ['recap'],
    };
    const out = writeWorkflow(t, inserted);
    expect(out.startsWith('# Workflow de livraison par défaut')).toBe(true);
    expect(equalWorkflows(model(out), inserted)).toBe(true);
    const back = writeWorkflow(out, w);
    expect(equalWorkflows(model(back), w)).toBe(true);
  });

  it('reorders stages by moving their nodes', () => {
    const t = text('default.yaml');
    const w = model(t);
    const swapped = { ...w, stages: [...w.stages].reverse() };
    const out = writeWorkflow(t, swapped);
    expect(model(out).stages.map((s) => s.id)).toEqual(swapped.stages.map((s) => s.id));
    expect(out).toContain('# Workflow de livraison par défaut');
  });

  it('writes `position` only for the stages in `moved`', () => {
    const t = text('default.yaml');
    const w = model(t);
    const placed: Workflow = {
      ...w,
      stages: w.stages.map((s) => ({ ...s, position: { x: 8, y: 16 } })),
    };
    const none = writeWorkflow(t, placed);
    expect(none).toBe(t);
    const some = writeWorkflow(t, placed, new Set(['dev']));
    const read = model(some);
    expect(read.stages.filter((s) => s.position).map((s) => s.id)).toEqual(['dev']);
    expect(read.stages.find((s) => s.id === 'dev')?.position).toEqual({ x: 8, y: 16 });
  });

  it('keeps the position the file already has for a stage that was not moved', () => {
    const t = text('positions.yaml');
    const w = model(t);
    const out = writeWorkflow(t, {
      ...w,
      stages: w.stages.map((s) => ({ ...s, position: { x: 1, y: 1 } })),
    });
    expect(out).toBe(t);
  });

  it('gives up on a text that is not a valid workflow and returns it as it is', () => {
    expect(writeWorkflow('- not\n- a map\n', defaultWorkflow(defaultDeliverySettings()))).toBe(
      '- not\n- a map\n',
    );
  });
});

describe('writeWorkflow creates a file (data-model order)', () => {
  const created = writeWorkflow(null, defaultWorkflow(defaultDeliverySettings()));

  it('writes the keys in the order of the data model, with no comment and no position', () => {
    const keys = created
      .split('\n')
      .filter((l) => /^[a-z]/.test(l))
      .map((l) => l.split(':')[0]);
    expect(keys).toEqual(['version', 'name', 'agents', 'stages', 'transitions', 'start', 'ends']);
    expect(created).not.toContain('#');
    expect(created).not.toContain('position');
  });

  it('is valid and equal to the model it was written from', () => {
    const w = defaultWorkflow(defaultDeliverySettings());
    expect(loadWorkflow(created)).toMatchObject({ errors: [], phase2: [] });
    expect(equalWorkflows(model(created), w)).toBe(true);
    expect(writeWorkflow(created, w)).toBe(created);
  });

  it('is deterministic', () => {
    expect(writeWorkflow(null, defaultWorkflow(defaultDeliverySettings()))).toBe(created);
  });

  it('writes the positions of the moved stages only, and the second phase after `ends`', () => {
    const w: Workflow = {
      ...defaultWorkflow(defaultDeliverySettings()),
      parallel: [{ id: 'g', stages: ['test', 'dev'], join: 'all' }],
    };
    const withPosition = {
      ...w,
      stages: w.stages.map((s) => ({ ...s, position: { x: 8, y: 8 } })),
    };
    const out = writeWorkflow(null, withPosition, new Set(['pr']));
    expect(out.match(/position/g)).toHaveLength(1);
    expect(
      out
        .trimEnd()
        .split('\n')
        .findIndex((l) => l.startsWith('parallel')),
    ).toBeGreaterThan(out.split('\n').findIndex((l) => l.startsWith('ends')));
  });
});

describe('writeWorkflow edits every shape of file', () => {
  const MIN = `version: 1
name: min
agents:
  dev: { role: dev }
  t:
    role: test
stages:
  - id: dev
    type: dev
    agents: [dev]
    instruction: "Un."
  - id: test
    type: test
    agents:
      - t
  - { id: pr, type: pr }
transitions:
  - { from: dev, to: test, on: [done] }
  - { from: test, to: dev, on: [defects], maxRounds: 2 }
  - { from: test, to: pr, on: [accepted] }
start: dev
ends: [pr]
`;
  const read = (t: string) => workflowSchema.parse(parseWorkflow(t).data);
  const edit = (change: (w: Workflow) => void, source = MIN) => {
    const w = structuredClone(model(source));
    change(w);
    const out = writeWorkflow(source, w);
    expect(equalWorkflows(read(out), w), out).toBe(true);
    return out;
  };
  const stage = (w: Workflow, id: string) => {
    const found = w.stages.find((s) => s.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it('removes a field of a block map, a field of a flow map, and a whole agent', () => {
    const out = edit((w) => {
      delete stage(w, 'dev').instruction;
      delete w.transitions[1]?.maxRounds;
      delete w.agents['t'];
      w.stages = w.stages.map((s) => (s.id === 'test' ? { ...s, agents: [] } : s));
    });
    expect(out).not.toContain('instruction');
    expect(out).not.toContain('maxRounds');
  });

  it('removes the first field of a flow map', () => {
    const out = edit((w) => {
      const t = w.transitions[1];
      if (t) t.maxRounds = undefined;
      const dev = w.agents['dev'];
      if (dev) dev.cli = 'codex';
    });
    expect(out).toContain('cli: codex');
  });

  it('adds fields to a block map and to a flow map', () => {
    const out = edit((w) => {
      stage(w, 'test').instruction = "Tests: d'abord, sans code.";
      stage(w, 'pr').mergeMode = 'rebase';
      const t = w.agents['t'];
      if (t) t.model = 'claude-sonnet-5-5';
      const dev = stage(w, 'dev');
      dev.agents = ['dev', 't'];
    });
    expect(out).toContain('mergeMode: rebase');
  });

  it('changes a block list, an empty one, and a padded flow list', () => {
    const out = edit((w) => {
      stage(w, 'test').agents = ['t', 'dev'];
      stage(w, 'dev').agents = [];
    });
    expect(out).toContain('- dev');
    const padded = edit(
      (w) => {
        w.ends = ['pr', 'dev'];
      },
      MIN.replace('ends: [pr]', 'ends: [ pr ]'),
    );
    expect(padded).toContain('ends: [ pr, dev ]');
  });

  it('writes strings that need quotes', () => {
    const out = edit((w) => {
      stage(w, 'pr').instruction = 'true';
      stage(w, 'dev').instruction = '12: x # y';
      w.name = 'min-2';
    });
    expect(out).toContain('"true"');
    expect(read(out).stages[0]?.instruction).toBe('12: x # y');
  });

  it('inserts a stage and a transition where they belong, and removes others', () => {
    const out = edit((w) => {
      w.agents['p'] = { role: 'dev' };
      w.stages.splice(1, 0, { id: 'mid', type: 'polish', agents: ['dev', 't'], passes: 1 });
      w.stages = w.stages.filter((s) => s.id !== 'pr');
      w.stages.push({ id: 'pr', type: 'pr', agents: [], mergeMode: 'merge' });
      w.transitions = w.transitions.filter((t) => t.on[0] !== 'defects');
      w.transitions.unshift({ from: 'spec', to: 'dev', on: ['ready'] });
    });
    expect(out.indexOf('id: mid')).toBeGreaterThan(out.indexOf('id: dev'));
  });

  it('reorders stages and transitions, keeping the lines of each', () => {
    const out = edit((w) => {
      w.stages.reverse();
      w.transitions.reverse();
    });
    expect(out.indexOf('id: pr')).toBeLessThan(out.indexOf('id: dev'));
    expect(out).toContain('instruction: "Un."');
  });

  it('adds and removes the second phase', () => {
    const withGroup = edit((w) => {
      w.parallel = [{ id: 'g', stages: ['dev', 'test'], join: 'any' }];
    });
    expect(withGroup).toContain('parallel:');
    expect(withGroup).toContain('join: any');
    const without = writeWorkflow(withGroup, model(MIN));
    expect(without).not.toContain('parallel');
  });

  it('does not touch a text with a syntax error', () => {
    expect(writeWorkflow('a: [1', model(MIN))).toBe('a: [1');
  });
});
