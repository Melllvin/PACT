import type { ChangedFile } from '../../shared/review';
import { seenBlob } from '../../shared/review';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

type Props = {
  files: ChangedFile[];
  /** `review.seen` of the agent: the content seen per path. */
  seen: Record<string, string>;
  selected: string | null;
  onSelect: (path: string) => void;
  onSeen: (file: ChangedFile, seen: boolean) => void;
};

const STATUS: Record<ChangedFile['status'], { letter: string; label: string; color: string }> = {
  added: { letter: 'A', label: 'ajouté', color: 'text-accept' },
  modified: { letter: 'M', label: 'modifié', color: 'text-waiting' },
  deleted: { letter: 'D', label: 'supprimé', color: 'text-destructive' },
  renamed: { letter: 'R', label: 'renommé', color: 'text-primary' },
};

/** A file is seen while its content is the one marked « vu » (FR-009). */
export const isSeen = (file: ChangedFile, seen: Record<string, string>) =>
  seen[file.path] === seenBlob(file);

/** The changed files of an agent (screen 1h, FR-007): kind, lines, « vu ». */
export function FileList({ files, seen, selected, onSelect, onSeen }: Props) {
  return (
    <ul aria-label="Fichiers" className="m-0 flex list-none flex-col gap-px p-0">
      {files.map((file) => {
        const status = STATUS[file.status];
        const checked = isSeen(file, seen);
        const current = file.path === selected;
        return (
          <li
            key={file.path}
            data-path={file.path}
            className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]',
              current ? 'bg-white/6' : 'hover:bg-white/3',
            )}
          >
            <Checkbox
              aria-label={`Vu : ${file.path}`}
              checked={checked}
              onCheckedChange={(value) => {
                onSeen(file, value === true);
              }}
            />
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              onClick={() => {
                onSelect(file.path);
              }}
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left',
                checked && 'text-muted-foreground',
              )}
            >
              <span aria-hidden className={cn('w-3 flex-none font-mono', status.color)}>
                {status.letter}
              </span>
              <span className="sr-only">{status.label} </span>
              <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                {file.path}
                {file.oldPath !== null && <span className="text-dim"> ← {file.oldPath}</span>}
              </span>
              {file.binary ? (
                <span className="flex-none font-mono text-[11px] text-dim">binaire</span>
              ) : (
                <span className="flex-none font-mono text-[11px]">
                  <span className="text-accept">+{file.added ?? 0}</span>{' '}
                  <span className="text-destructive">−{file.removed ?? 0}</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
