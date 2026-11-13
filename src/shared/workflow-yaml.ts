import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  MAX_WORKFLOW_BYTES,
  equalWorkflows,
  validateWorkflow,
  workflowSchema,
  type LineMap,
  type Validation,
  type Stage,
  type Workflow,
  type WorkflowIssue,
} from './workflow';

// 010 research R3 and R13 — the YAML side of the workflow: reading with the line of every node, and
// writing that touches only what changed, so that comments, order and style survive (FR-005, FR-006).

export type Parsed = { data: unknown; lines: LineMap; errors: WorkflowIssue[] };

const CONFLICT = /^(<<<<<<<|=======|>>>>>>>)( |$)/m;

/** R3 — one document, no anchor, alias nor tag, no duplicate key, at most 64 KiB. */
export function parseWorkflow(text: string): Parsed {
  const errors: WorkflowIssue[] = [];
  const fail = (issue: WorkflowIssue): Parsed => {
    errors.push(issue);
    return { data: null, lines: {}, errors };
  };
  if (new TextEncoder().encode(text).length > MAX_WORKFLOW_BYTES) {
    return fail({
      code: 'too-large',
      message: 'Fichier trop grand : 64 Kio au plus',
      line: 1,
    });
  }
  const conflict = CONFLICT.exec(text);
  if (conflict) {
    const line = text.slice(0, conflict.index).split('\n').length;
    return fail({
      code: 'syntax',
      message: `Ligne ${String(line)} : marqueur de conflit Git`,
      line,
    });
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    uniqueKeys: true,
    customTags: [],
    merge: false,
    strict: true,
    prettyErrors: false,
  });
  for (const error of doc.errors) {
    const pos = lineCounter.linePos(error.pos[0]);
    const duplicate = error.code === 'DUPLICATE_KEY';
    const reason = duplicate ? 'clé en double' : (error.message.split('\n')[0] ?? error.message);
    errors.push({
      code: duplicate ? 'duplicate-key' : 'syntax',
      message: `Ligne ${String(pos.line)} : ${reason}`,
      line: pos.line,
      column: pos.col,
    });
  }
  if (errors.length > 0) return { data: null, lines: {}, errors };

  const lines: Record<string, number> = {};
  const lineAt = (node: Node | null | undefined) =>
    node?.range ? lineCounter.linePos(node.range[0]).line : undefined;
  const flagged = (node: Node, kind: string) => {
    const line = lineAt(node);
    errors.push({
      code: 'alias',
      message: `Ligne ${String(line ?? '?')} : ${kind} non permis`,
      ...(line === undefined ? {} : { line }),
    });
  };
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const here = node as Node;
    if (isAlias(here)) {
      flagged(here, 'alias');
      return;
    }
    if ('anchor' in here && here.anchor) flagged(here, 'ancre');
    if ('tag' in here && here.tag) flagged(here, 'étiquette');
    const line = lineAt(here);
    if (line !== undefined) lines[path] = line;
    if (isMap(here)) {
      for (const pair of here.items) {
        const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
        const child = path === '' ? key : `${path}.${key}`;
        const keyLine = lineAt(pair.key as Node);
        if (keyLine !== undefined) lines[child] = keyLine;
        walk(pair.value, child);
        if (keyLine !== undefined) lines[child] = keyLine;
      }
    } else if (isSeq(here)) {
      here.items.forEach((item, index) => {
        walk(item, `${path}.${String(index)}`.replace(/^\./, ''));
      });
    }
  };
  if (doc.contents) walk(doc.contents, '');
  if (errors.length > 0) return { data: null, lines, errors };
  return { data: doc.toJS(), lines, errors };
}

/** The text of a file read and checked: the syntax errors, then the rules of `validateWorkflow`. */
export function loadWorkflow(text: string): Validation {
  const parsed = parseWorkflow(text);
  if (parsed.errors.length > 0) return { workflow: null, errors: parsed.errors, phase2: [] };
  return validateWorkflow(parsed.data, parsed.lines);
}

// ---------------------------------------------------------------------------------- writing

// The text of a file is never regenerated: every change is an edit of the range of the node it
// concerns, so what did not change stays byte for byte, comments and style included (R13).

type Plain = Record<string, unknown>;
type Edit = { at: number; end: number; text: string };

const FIELDS_STAGE = ['id', 'type', 'agents', 'instruction', 'passes', 'mergeMode', 'position'];
const FIELDS_TRANSITION = ['from', 'to', 'on', 'maxRounds', 'when'];
const FIELDS_AGENT = ['role', 'cli', 'model'];
const FIELDS_PARALLEL = ['id', 'stages', 'join'];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A scalar written so that it reads back the same in a flow collection (plain when it is safe). */
function scalar(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const plain = /^[\p{L}_][\p{L}\p{N}_\-. ]*$/u.test(value) && !value.endsWith(' ');
  const reserved = /^(true|false|null|yes|no|on|off|y|n)$/i.test(value);
  return plain && !reserved ? value : JSON.stringify(value);
}

/** `[a, b]`, `{ k: v }`, or a scalar: the flow form of a value, maps padded and lists not, as in the contract. */
function render(value: unknown, fields?: readonly string[]): string {
  if (Array.isArray(value)) return `[${value.map((item) => render(item)).join(', ')}]`;
  if (isRecord(value)) {
    const keys = (fields ?? Object.keys(value)).filter((key) => value[key] !== undefined);
    const rest = Object.keys(value).filter(
      (key) => !keys.includes(key) && value[key] !== undefined,
    );
    const pairs = [...keys, ...rest].map((key) => `${key}: ${render(value[key])}`);
    return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
  }
  return scalar(value);
}

const lineStart = (src: string, at: number) => src.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (src: string, at: number) => {
  const next = src.indexOf('\n', at);
  return next < 0 ? src.length : next;
};
const keyName = (pair: Pair): string => String(isScalar(pair.key) ? pair.key.value : pair.key);
const pairOf = (map: YAMLMap, key: string): Pair | undefined =>
  map.items.find((pair) => keyName(pair) === key);
const end = (node: Node) => (node.range as [number, number, number])[1];
const begin = (node: Node) => (node.range as [number, number, number])[0];

/** Removes a pair of a map, with its line in a block map, with its comma in a flow map. */
function deletePair(src: string, map: YAMLMap, pair: Pair, edits: Edit[]) {
  const key = pair.key as Node;
  const value = pair.value as Node | null;
  const stop = value?.range ? end(value) : end(key) + 1;
  if (map.flow) {
    const at = map.items.indexOf(pair);
    if (map.items.length === 1) return edits.push({ at: begin(map), end: end(map), text: '{}' });
    if (at > 0) {
      const before = map.items[at - 1]?.value as Node | null;
      return edits.push({ at: before?.range ? end(before) : begin(key), end: stop, text: '' });
    }
    const after = map.items[1]?.key as Node;
    return edits.push({ at: begin(key), end: begin(after), text: '' });
  }
  const first = lineStart(src, begin(key));
  const alone = src.slice(first, begin(key)).trim() === '';
  if (alone)
    edits.push({ at: first, end: Math.min(lineEnd(src, stop - 1) + 1, src.length), text: '' });
  else edits.push({ at: begin(key), end: stop, text: '' });
}

/** Adds a pair at the end of a map. */
function addPair(src: string, map: YAMLMap, key: string, value: unknown, edits: Edit[]) {
  const last = map.items.at(-1);
  const text = `${key}: ${render(value)}`;
  if (!last) return edits.push({ at: begin(map), end: end(map), text: `{ ${text} }` });
  const lastValue = last.value as Node | null;
  const stop = lastValue?.range ? end(lastValue) : end(last.key as Node) + 1;
  if (map.flow) return edits.push({ at: stop, end: stop, text: `, ${text}` });
  const indent = ' '.repeat(
    begin(map.items[0]?.key as Node) - lineStart(src, begin(map.items[0]?.key as Node)),
  );
  const at = lineEnd(src, Math.max(stop - 1, 0));
  edits.push({ at, end: at, text: `\n${indent}${text}` });
}

/** Replaces the value of a pair, keeping the flow or block style of a list. */
function setValue(src: string, pair: Pair, value: unknown, edits: Edit[]) {
  const node = pair.value as Node | null;
  if (!node?.range) {
    return edits.push({
      at: end(pair.key as Node) + 1,
      end: end(pair.key as Node) + 1,
      text: ` ${render(value)}`,
    });
  }
  if (isSeq(node) && Array.isArray(value) && !node.flow && value.length > 0) {
    const first = node.items[0] as Node;
    const indent = ' '.repeat(begin(first) - lineStart(src, begin(first)) - 2);
    const lines = value.map((item) => `- ${render(item)}`);
    const last = node.items.at(-1) as Node;
    return edits.push({
      at: begin(first) - 2,
      end: end(last),
      text: lines.join(`\n${indent}`),
    });
  }
  if (isSeq(node) && Array.isArray(value)) {
    const padded = node.flow && src[begin(node) + 1] === ' ';
    const text = render(value);
    return edits.push({
      at: begin(node),
      end: end(node),
      text: padded && value.length > 0 ? `[ ${text.slice(1, -1)} ]` : text,
    });
  }
  edits.push({ at: begin(node), end: end(node), text: render(value) });
}

/** The fields of `next` that differ from `prev`, written into a map node. */
function patchMap(
  src: string,
  map: YAMLMap,
  prev: Plain,
  next: Plain,
  fields: readonly string[],
  edits: Edit[],
) {
  for (const key of fields) {
    if (same(prev[key], next[key])) continue;
    const pair = pairOf(map, key);
    if (next[key] === undefined) {
      if (pair) deletePair(src, map, pair, edits);
    } else if (pair) setValue(src, pair, next[key], edits);
    else addPair(src, map, key, next[key], edits);
  }
}

const withoutDefaults = (stage: Plain): Plain => {
  const copy: Plain = { ...stage };
  if (Array.isArray(copy.agents) && copy.agents.length === 0) delete copy.agents;
  return copy;
};

/**
 * The items of a block list, matched to the new ones: patched when kept, removed when gone, inserted
 * (in their place) when new. `match` pairs a new item with an old one.
 */
function patchList<T extends Plain>(
  src: string,
  seq: YAMLSeq,
  prev: readonly T[],
  next: readonly T[],
  match: (item: T, free: readonly (T | null)[]) => number,
  fields: readonly string[],
  clean: (item: T) => Plain,
  edits: Edit[],
) {
  const free: (T | null)[] = [...prev];
  const from = next.map((item) => {
    const at = match(item, free);
    if (at >= 0) free[at] = null;
    return at;
  });
  prev.forEach((_item, index) => {
    if (from.includes(index)) return;
    const node = seq.items[index] as Node;
    edits.push({
      at: lineStart(src, begin(node)),
      end: Math.min(lineEnd(src, end(node) - 1) + 1, src.length),
      text: '',
    });
  });
  const indent = (node: Node) =>
    ' '.repeat(Math.max(begin(node) - lineStart(src, begin(node)) - 2, 0));
  next.forEach((item, index) => {
    const old = from[index] as number;
    if (old >= 0) {
      const node = seq.items[old];
      const was = prev[old] as T;
      if (isMap(node)) patchMap(src, node, clean(was), clean(item), fields, edits);
      return;
    }
    const text = render(clean(item), fields);
    const following = from.slice(index + 1).find((at) => at >= 0);
    if (following !== undefined) {
      const node = seq.items[following] as Node;
      edits.push({
        at: lineStart(src, begin(node)),
        end: lineStart(src, begin(node)),
        text: `${indent(node)}- ${text}\n`,
      });
    } else {
      const lastKept = [...from].reverse().find((at) => at >= 0);
      const node = (seq.items[lastKept ?? prev.length - 1] ?? seq.items.at(-1)) as Node;
      const at = lineEnd(src, Math.max(end(node) - 1, 0));
      edits.push({ at, end: at, text: `\n${indent(node)}- ${text}` });
    }
  });
  return from;
}

const apply = (src: string, edits: readonly Edit[]): string =>
  [...edits]
    .sort((a, b) => b.at - a.at || b.end - a.end)
    .reduce((text, edit) => text.slice(0, edit.at) + edit.text + text.slice(edit.end), src);

/** The items of a block list put in a new order, each with its own lines. */
function reorder(
  src: string,
  key: string,
  order: readonly string[],
  keyOf: (node: YAMLMap, n: number) => string,
): string {
  const doc = parseDocument(src, { customTags: [] });
  const seq = isMap(doc.contents) ? doc.contents.get(key, true) : null;
  if (!isSeq(seq) || seq.flow) return src;
  const seen = new Map<string, number>();
  const blocks = new Map<string, string>();
  for (const item of seq.items) {
    if (!isMap(item)) return src;
    const at = lineStart(src, begin(item));
    blocks.set(
      keyOf(item, 0) + '#' + String(seen.get(keyOf(item, 0)) ?? 0),
      src.slice(at, lineEnd(src, end(item) - 1)),
    );
    seen.set(keyOf(item, 0), (seen.get(keyOf(item, 0)) ?? 0) + 1);
  }
  const first = lineStart(src, begin(seq.items[0] as Node));
  const last = lineEnd(src, end(seq.items.at(-1) as Node) - 1);
  const counts = new Map<string, number>();
  const body = order.map((name) => {
    const n = counts.get(name) ?? 0;
    counts.set(name, n + 1);
    return blocks.get(`${name}#${String(n)}`) ?? '';
  });
  return src.slice(0, first) + body.join('\n') + src.slice(last);
}

const transitionKey = (t: { from: string; to: string }) => `${t.from}>${t.to}`;

/**
 * R13 — the text of `next`. Without a text, a new file; with one, the same text where the model did
 * not change (byte for byte), and only the changed fields rewritten where it did. `moved` lists the
 * stages whose `position` is written: the others keep what the file says.
 */
export function writeWorkflow(
  text: string | null,
  next: Workflow,
  moved: ReadonlySet<string> = new Set(),
): string {
  if (text === null) return createText(next, moved);
  const doc = parseDocument(text, { uniqueKeys: true, customTags: [], merge: false });
  const root = doc.contents;
  const current = workflowSchema.safeParse(doc.toJS());
  if (!isMap(root) || !current.success || doc.errors.length > 0) return text;
  const prev = current.data;

  // The position of a stage that was not moved is the file's own.
  const target: Workflow = {
    ...next,
    stages: next.stages.map((stage) => {
      if (moved.has(stage.id)) return stage;
      const old = prev.stages.find((candidate) => candidate.id === stage.id);
      const rest: Stage = { ...stage };
      delete rest.position;
      return old?.position ? { ...rest, position: old.position } : rest;
    }),
  };
  if (equalWorkflows(prev, target)) return text;

  const edits: Edit[] = [];
  patchMap(text, root, prev, target, ['version', 'name', 'start', 'ends'], edits);

  const agents = root.get('agents', true);
  if (isMap(agents)) {
    for (const key of Object.keys(prev.agents)) {
      const pair = pairOf(agents, key);
      if (!(key in target.agents) && pair) deletePair(text, agents, pair, edits);
    }
    for (const [key, agent] of Object.entries(target.agents)) {
      const pair = pairOf(agents, key);
      const was = prev.agents[key];
      if (pair && isMap(pair.value) && was) {
        patchMap(text, pair.value, was, agent, FIELDS_AGENT, edits);
      } else if (!pair) addPair(text, agents, key, agent, edits);
    }
  }

  let stageOrder: string[] | null = null;
  const stages = root.get('stages', true);
  if (isSeq(stages) && !stages.flow) {
    const kept = patchList(
      text,
      stages,
      prev.stages as unknown as Plain[],
      target.stages as unknown as Plain[],
      (item, free) => free.findIndex((old) => old !== null && old.id === item.id),
      FIELDS_STAGE,
      withoutDefaults,
      edits,
    );
    const order = kept.filter((at) => at >= 0);
    if (order.some((at, i) => i > 0 && at < (order[i - 1] as number))) {
      stageOrder = target.stages.map((stage) => stage.id);
    }
  }

  let transitionOrder: string[] | null = null;
  const transitions = root.get('transitions', true);
  if (isSeq(transitions) && !transitions.flow) {
    const kept = patchList(
      text,
      transitions,
      prev.transitions as unknown as Plain[],
      target.transitions as unknown as Plain[],
      (item, free) =>
        free.findIndex(
          (old) => old !== null && transitionKey(old as never) === transitionKey(item as never),
        ),
      FIELDS_TRANSITION.filter((key) => key !== 'when'),
      (t) => t,
      edits,
    );
    const order = kept.filter((at) => at >= 0);
    if (order.some((at, i) => i > 0 && at < (order[i - 1] as number))) {
      transitionOrder = target.transitions.map(transitionKey);
    }
  }

  const parallel = pairOf(root, 'parallel');
  if (target.parallel && !parallel) {
    const last = root.items.at(-1) as Pair;
    const at = lineEnd(text, Math.max(end((last.value ?? last.key) as Node) - 1, 0));
    edits.push({
      at,
      end: at,
      text: `\nparallel:\n${target.parallel.map((g) => `  - ${render(g, FIELDS_PARALLEL)}`).join('\n')}`,
    });
  } else if (!target.parallel && parallel) deletePair(text, root, parallel, edits);

  let out = apply(text, edits);
  if (stageOrder) out = reorder(out, 'stages', stageOrder, (node) => String(node.get('id')));
  if (transitionOrder) {
    out = reorder(
      out,
      'transitions',
      transitionOrder,
      (node) => `${String(node.get('from'))}>${String(node.get('to'))}`,
    );
  }
  return out;
}

/** A new file: the keys in the order of data-model, no position unless moved, no comment. */
function createText(next: Workflow, moved: ReadonlySet<string>): string {
  const lines = [`version: ${String(next.version)}`, `name: ${scalar(next.name)}`, 'agents:'];
  for (const [key, agent] of Object.entries(next.agents))
    lines.push(`  ${key}: ${render(agent, FIELDS_AGENT)}`);
  lines.push('stages:');
  for (const stage of next.stages) {
    const plain = withoutDefaults(stage);
    if (!moved.has(stage.id)) delete plain.position;
    lines.push(`  - ${render(plain, FIELDS_STAGE)}`);
  }
  lines.push('transitions:');
  for (const t of next.transitions) lines.push(`  - ${render(t, FIELDS_TRANSITION)}`);
  lines.push(`start: ${scalar(next.start)}`, `ends: ${render(next.ends)}`);
  if (next.parallel) {
    lines.push('parallel:');
    for (const group of next.parallel) lines.push(`  - ${render(group, FIELDS_PARALLEL)}`);
  }
  return `${lines.join('\n')}\n`;
}
