import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangedFile, DiffHunk, DiffLine, FileDiff } from '../../shared/review';
import { cn } from '@/lib/utils';

type Props = {
  file: ChangedFile;
  /** `null` while it loads. */
  diff: FileDiff | null;
  /** The height shown; measured in the app, given where nothing is laid out (tests). */
  viewportHeight?: number;
};

type Row = { kind: 'hunk'; text: string } | DiffLine;

/** Every row has this height: the rows shown follow from the scroll alone (R10). */
const ROW = 20;
/** Rows rendered above and below the visible ones, so a fast scroll shows no gap. */
const OVERSCAN = 10;
const FALLBACK_HEIGHT = 600;

const KIND_LABEL: Record<ChangedFile['status'], string> = {
  added: 'ajouté',
  modified: 'modifié',
  deleted: 'supprimé',
  renamed: 'renommé',
};

const SIGN: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '−' };

/** « 2,0 Ko », « 3,1 Mo »: the size of a file shown without its lines. */
export function formatSize(bytes: number) {
  const format = (n: number) =>
    n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 1024) return `${String(bytes)} octets`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} Ko`;
  return `${format(bytes / (1024 * 1024))} Mo`;
}

/** `@@ -1,2 +1,3 @@`, counted from the lines of the hunk. */
function hunkHeader({ oldStart, newStart, lines }: DiffHunk) {
  const old = lines.filter((line) => line.kind !== 'add').length;
  const added = lines.filter((line) => line.kind !== 'del').length;
  return `@@ -${String(oldStart)},${String(old)} +${String(newStart)},${String(added)} @@`;
}

const toRows = (hunks: DiffHunk[]): Row[] =>
  hunks.flatMap((hunk): Row[] => [{ kind: 'hunk', text: hunkHeader(hunk) }, ...hunk.lines]);

const NOTE = 'm-0 px-4 py-6 text-[13px] text-muted-foreground';

/**
 * The diff of one file against main (FR-008): removed lines red, added green, the numbers of both
 * sides. Only the rows in view are rendered, so a 5 000 line file scrolls as fast as a short one.
 */
export function DiffView({ file, diff, viewportHeight }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || viewportHeight !== undefined) return;
    const measure = () => {
      setMeasured(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [viewportHeight, diff]);

  // Another file starts at its top.
  const [shownPath, setShownPath] = useState(file.path);
  if (shownPath !== file.path) {
    setShownPath(file.path);
    setScrollTop(0);
  }

  const kind = KIND_LABEL[file.status];
  if (file.binary || file.tooLarge) {
    const size = diff ? ` · ${formatSize(diff.size)}` : '';
    return (
      <p className={NOTE}>
        {file.binary
          ? `Fichier binaire ${kind}${size}`
          : `Fichier trop gros pour un diff ligne à ligne, ${kind}${size}`}
      </p>
    );
  }
  if (file.eolOnly) return <p className={NOTE}>Fins de ligne seulement</p>;
  if (!diff) return <p className={NOTE}>Chargement du diff…</p>;

  const rows = toRows(diff.hunks);
  const height = viewportHeight ?? (measured || FALLBACK_HEIGHT);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);

  return (
    <div
      ref={box}
      role="table"
      aria-label={`Diff de ${file.path}`}
      aria-rowcount={rows.length}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
      className="relative min-h-0 flex-1 overflow-auto font-mono text-[12px]"
    >
      <div role="rowgroup" style={{ height: rows.length * ROW }} className="relative min-w-max">
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const style = { top: index * ROW, height: ROW };
          if (row.kind === 'hunk') {
            return (
              <div
                key={index}
                role="row"
                aria-rowindex={index + 1}
                data-kind="hunk"
                style={style}
                className="absolute inset-x-0 flex items-center bg-white/3 px-3 text-dim"
              >
                <span role="cell">{row.text}</span>
              </div>
            );
          }
          return (
            <div
              key={index}
              role="row"
              aria-rowindex={index + 1}
              data-kind={row.kind}
              style={style}
              className={cn(
                'absolute inset-x-0 flex items-center whitespace-pre',
                row.kind === 'add' && 'bg-accept/10',
                row.kind === 'del' && 'bg-destructive/10',
              )}
            >
              <span role="cell" className="w-12 flex-none pr-2 text-right text-dim select-none">
                {row.oldNo ?? ''}
              </span>
              <span role="cell" className="w-12 flex-none pr-2 text-right text-dim select-none">
                {row.newNo ?? ''}
              </span>
              <span
                role="cell"
                className={cn(
                  'w-4 flex-none select-none',
                  row.kind === 'add' && 'text-accept',
                  row.kind === 'del' && 'text-destructive',
                )}
              >
                {SIGN[row.kind]}
              </span>
              <span role="cell" className="pr-4">
                {row.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
