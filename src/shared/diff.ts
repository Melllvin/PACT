import type { DiffHunk, DiffLine } from './review';

// 002 research R2 — the `git diff` of one file, read into hunks with line numbers on both sides.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Lines before the first `@@` are headers (paths, modes, « Binary files … differ ») and are
 * skipped. Inside a hunk, each line is read by its first character only, so content that looks
 * like a header (`--- x`) stays content. The carriage return of a CRLF line is dropped.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of text.split('\n')) {
    const header = oldLeft === 0 && newLeft === 0 ? HUNK_HEADER.exec(raw) : null;
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { oldStart: oldNo, newStart: newNo, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || (oldLeft === 0 && newLeft === 0)) continue;

    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const line = read(body.charAt(0), body.slice(1));
    if (!line) continue;
    hunk.lines.push(line);
  }
  return hunks;

  function read(mark: string, content: string): DiffLine | undefined {
    if (mark === '+') {
      newLeft--;
      return { kind: 'add', oldNo: null, newNo: newNo++, text: content };
    }
    if (mark === '-') {
      oldLeft--;
      return { kind: 'del', oldNo: oldNo++, newNo: null, text: content };
    }
    if (mark === ' ') {
      oldLeft--;
      newLeft--;
      return { kind: 'context', oldNo: oldNo++, newNo: newNo++, text: content };
    }
    // « \ No newline at end of file » and anything unexpected.
    return undefined;
  }
}
