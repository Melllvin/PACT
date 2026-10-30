import { MessageSquarePlus } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ReviewComment } from '../../shared/model';
import type { ChangedFile, DiffHunk, DiffLine, FileDiff } from '../../shared/review';
import { cn } from '@/lib/utils';

type Props = {
  file: ChangedFile;
  /** `null` while it loads. */
  diff: FileDiff | null;
  /** The height shown; measured in the app, given where nothing is laid out (tests). */
  viewportHeight?: number;
  /** The comments on this file, shown under their line (FR-012). */
  comments?: readonly ReviewComment[];
  /** Without it, lines cannot be commented. `line` is on the agent's side of the diff. */
  onComment?: ((line: number, text: string) => void) | undefined;
};

type Row =
  | { kind: 'hunk'; text: string }
  | DiffLine
  | { kind: 'comment'; comment: ReviewComment }
  | { kind: 'editor'; line: number };

/** Each kind of row has a fixed height: the rows shown follow from the scroll alone (R10). */
const ROW = 20;
const HEIGHT: Record<Row['kind'], number> = {
  hunk: ROW,
  context: ROW,
  add: ROW,
  del: ROW,
  comment: 44,
  editor: 40,
};
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

/** The lines of the diff, each followed by its comments and, while writing one, its field. */
function toRows(hunks: DiffHunk[], comments: readonly ReviewComment[], editing: number | null) {
  const placed = new Set<number>();
  const after = (line: DiffLine): Row[] => {
    if (line.kind === 'del' || line.newNo === null || placed.has(line.newNo)) return [];
    placed.add(line.newNo);
    const own = comments.filter((comment) => comment.line === line.newNo);
    const rows: Row[] = own.map((comment) => ({ kind: 'comment', comment }));
    if (editing === line.newNo) rows.push({ kind: 'editor', line: line.newNo });
    return rows;
  };
  return hunks.flatMap((hunk): Row[] => [
    { kind: 'hunk', text: hunkHeader(hunk) },
    ...hunk.lines.flatMap((line) => [line, ...after(line)]),
  ]);
}

/** The index of the last row starting at or before `y`, in `tops` sorted ascending. */
function rowAt(tops: number[], y: number) {
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((tops[middle] ?? 0) <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Enter sends the comment, Escape drops it; neither goes further (the Focus keeps Escape). */
function CommentField({
  line,
  onSubmit,
  onCancel,
}: {
  line: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onCancel();
    } else if (event.key === 'Enter' && text.trim() !== '') {
      event.preventDefault();
      onSubmit(text.trim());
    }
  };
  return (
    <input
      // Opened by a click on the line: the comment is written straight away.
      autoFocus
      aria-label={`Commentaire sur la ligne ${String(line)}`}
      placeholder="Commentaire pour l’agent · Entrée pour envoyer, Échap pour annuler"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={onKeyDown}
      className="h-7 w-full max-w-[640px] rounded-lg border border-primary/50 bg-background px-2.5 font-sans text-[12.5px] text-foreground outline-none"
    />
  );
}

const NOTE = 'm-0 px-4 py-6 text-[13px] text-muted-foreground';

/**
 * The diff of one file against main (FR-008): removed lines red, added green, the numbers of both
 * sides. Only the rows in view are rendered, so a 5 000 line file scrolls as fast as a short one.
 */
export function DiffView({ file, diff, viewportHeight, comments = [], onComment }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  /** The line whose comment field is open. */
  const [editing, setEditing] = useState<number | null>(null);

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
    setEditing(null);
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

  const rows = toRows(diff.hunks, comments, editing);
  const tops: number[] = [];
  let total = 0;
  for (const row of rows) {
    tops.push(total);
    total += HEIGHT[row.kind];
  }
  const height = viewportHeight ?? (measured || FALLBACK_HEIGHT);
  const first = Math.max(0, rowAt(tops, scrollTop) - OVERSCAN);
  const last = Math.min(rows.length, rowAt(tops, scrollTop + height) + 1 + OVERSCAN);

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
      <div role="rowgroup" style={{ height: total }} className="relative min-w-max">
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const style = { top: tops[index], height: HEIGHT[row.kind] };
          if (row.kind === 'comment') {
            return (
              <div
                key={row.comment.id}
                role="row"
                aria-rowindex={index + 1}
                data-kind="comment"
                style={style}
                className="absolute inset-x-0 flex items-center pl-[112px]"
              >
                <div
                  role="note"
                  aria-label={`Commentaire sur la ligne ${String(row.comment.line)}`}
                  className={cn(
                    'flex max-w-[640px] min-w-0 flex-col gap-0.5 rounded-lg border border-primary/30 bg-primary/8 px-2.5 py-1 font-sans text-[12px]',
                    row.comment.treated && 'opacity-60',
                  )}
                >
                  <span className="truncate text-foreground">{row.comment.text}</span>
                  <span className="text-[10.5px] text-primary">→ envoyé à l’agent ↓</span>
                </div>
              </div>
            );
          }
          if (row.kind === 'editor') {
            return (
              <div
                key={`editor-${String(row.line)}`}
                role="row"
                aria-rowindex={index + 1}
                data-kind="editor"
                style={style}
                className="absolute inset-x-0 flex items-center pl-[112px]"
              >
                <CommentField
                  line={row.line}
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onSubmit={(text) => {
                    setEditing(null);
                    onComment?.(row.line, text);
                  }}
                />
              </div>
            );
          }
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
                'group absolute inset-x-0 flex items-center whitespace-pre',
                row.kind === 'add' && 'bg-accept/10',
                row.kind === 'del' && 'bg-destructive/10',
              )}
            >
              {onComment && row.newNo !== null && (
                <button
                  type="button"
                  aria-label={`Commenter la ligne ${String(row.newNo)}`}
                  onClick={() => {
                    setEditing(row.newNo);
                  }}
                  className="absolute left-0.5 flex size-4 cursor-pointer items-center justify-center rounded text-primary opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <MessageSquarePlus aria-hidden className="size-3" />
                </button>
              )}
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
