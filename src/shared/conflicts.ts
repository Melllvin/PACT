import type { ConflictChoice, ConflictFile, ConflictHunk } from './review';

// 002 R6 — the conflict markers git writes in a merged file, cut into hunks, and the choices of
// screen 1q applied to them. Pure: the main process and the renderer share it.

const START = '<<<<<<<';
const BASE = '|||||||';
const MIDDLE = '=======';
const END = '>>>>>>>';

/** `line` is `marker`, alone or followed by a label; a CR left by CRLF is ignored. */
const isMarker = (line: string, marker: string) => {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
  return bare === marker || bare.startsWith(`${marker} `);
};

type Block = { kind: 'text'; lines: string[] } | { kind: 'conflict'; hunk: ConflictHunk };

/** The file as text and conflicts, in order. Lines keep their CR; the last one may be ''. */
function blocks(text: string): Block[] {
  const lines = text.split('\n');
  const result: Block[] = [];
  let mainLine = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!isMarker(line, START)) {
      const last = result.at(-1);
      if (last?.kind === 'text') last.lines.push(line);
      else result.push({ kind: 'text', lines: [line] });
      mainLine += 1;
      i += 1;
      continue;
    }
    const hunk: ConflictHunk = {
      index: result.filter((b) => b.kind === 'conflict').length,
      line: mainLine + 1,
      main: [],
      agent: [],
      resolution: null,
    };
    let side: 'main' | 'base' | 'agent' = 'main';
    for (i += 1; i < lines.length && !isMarker(lines[i] ?? '', END); i += 1) {
      const inner = lines[i] ?? '';
      if (side === 'main' && isMarker(inner, BASE)) side = 'base';
      else if (side !== 'agent' && inner.replace(/\r$/, '') === MIDDLE) side = 'agent';
      else if (side === 'main') hunk.main.push(inner);
      else if (side === 'agent') hunk.agent.push(inner);
    }
    i += 1;
    mainLine += hunk.main.length;
    result.push({ kind: 'conflict', hunk });
  }
  return result;
}

export function parseConflicts(text: string): ConflictHunk[] {
  return blocks(text).flatMap((block) => (block.kind === 'conflict' ? [block.hunk] : []));
}

const chosen = (hunk: ConflictHunk, choice: ConflictChoice) =>
  choice === 'main' ? hunk.main : choice === 'agent' ? hunk.agent : [...hunk.main, ...hunk.agent];

/** `text` with each resolved hunk replaced by its choice; the others keep their markers. */
export function applyResolutions(text: string, hunks: readonly ConflictHunk[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  for (const block of blocks(text)) {
    if (block.kind === 'text') {
      out.push(...block.lines);
      i += block.lines.length;
      continue;
    }
    // The markers as they were, up to and including the end marker.
    const end = lines.findIndex((line, at) => at > i && isMarker(line, END));
    const raw = lines.slice(i, end === -1 ? lines.length : end + 1);
    i += raw.length;
    const resolution = hunks.find((h) => h.index === block.hunk.index)?.resolution ?? null;
    out.push(...(resolution === null ? raw : chosen(block.hunk, resolution)));
  }
  return out.join('\n');
}

export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((line) => isMarker(line, START) || isMarker(line, END));
}

type Resolvable = Pick<ConflictFile, 'hunks' | 'edited'>;

/** Resolved by a choice for every hunk, or by an edit without markers left (FR-029). */
export function isFileResolved(file: Resolvable): boolean {
  if (file.edited !== null) return !hasConflictMarkers(file.edited);
  return file.hunks.every((hunk) => hunk.resolution !== null);
}

/** The content the file will have, as resolved so far. */
export function resultOf(file: Resolvable & Pick<ConflictFile, 'merged' | 'whole'>): string {
  if (file.edited !== null) return file.edited;
  if (!file.whole) return applyResolutions(file.merged, file.hunks);
  const [hunk] = file.hunks;
  if (!hunk?.resolution) return '';
  const lines = chosen(hunk, hunk.resolution);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** « Les deux » only makes sense where both sides are text to put together (R6). */
export const choicesFor = (file: Pick<ConflictFile, 'whole'>): ConflictChoice[] =>
  file.whole ? ['main', 'agent'] : ['main', 'agent', 'both'];
