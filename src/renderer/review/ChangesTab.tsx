import type { ChangedFile, FileDiff, ReviewSnapshot } from '../../shared/review';
import { DiffView } from './DiffView';
import { FileList, isSeen } from './FileList';

type Props = {
  /** `null` until the first snapshot arrives. */
  snapshot: ReviewSnapshot | null;
  seen: Record<string, string>;
  selected: string | null;
  diff: FileDiff | null;
  /** Why the review could not be read. */
  error: string | null;
  onSelect: (path: string) => void;
  onSeen: (file: ChangedFile, seen: boolean) => void;
};

const NOTE = 'm-0 px-4 py-8 text-center text-[13px] text-muted-foreground';

/**
 * The Changements tab of the Focus (screen 1h): what the agent changed against main, file by
 * file, with what was already seen (FR-006…FR-010).
 */
export function ChangesTab({ snapshot, seen, selected, diff, error, onSelect, onSeen }: Props) {
  if (error && !snapshot) {
    return (
      <p role="alert" className="m-4 text-[13px] text-destructive">
        {error}
      </p>
    );
  }
  if (!snapshot) return <p className={NOTE}>Chargement des changements…</p>;
  if (snapshot.missing) return <p className={NOTE}>Le worktree de cet agent est introuvable.</p>;

  const { files } = snapshot;
  const seenCount = files.filter((file) => isSeen(file, seen)).length;
  const shown = files.find((file) => file.path === selected);
  // « revoir » goes to the first file seen before and changed since.
  const changedSinceSeen = files.find(
    (file) => seen[file.path] !== undefined && !isSeen(file, seen),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="group"
        aria-label="Résumé des changements"
        className="flex flex-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/6 px-3.5 py-2.5"
      >
        <h2 className="m-0 text-[14px] font-medium">Changements · {files.length}</h2>
        <span className="font-mono text-[11px] text-dim">⎇ {snapshot.branch}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          <span className="text-accept">+{snapshot.added}</span>{' '}
          <span className="text-destructive">−{snapshot.removed}</span> · {seenCount} /{' '}
          {files.length} vus
        </span>
      </div>
      {snapshot.newSinceSeen && (
        <p
          role="status"
          className="m-0 flex flex-none items-center gap-1 border-b border-white/6 bg-waiting/8 px-3.5 py-1.5 text-[12px]"
        >
          Nouveaux changements : +{snapshot.newSinceSeen.added} −{snapshot.newSinceSeen.removed} ·{' '}
          <button
            type="button"
            disabled={!changedSinceSeen}
            onClick={() => {
              if (changedSinceSeen) onSelect(changedSinceSeen.path);
            }}
            className="cursor-pointer text-primary underline-offset-2 hover:underline"
          >
            revoir
          </button>
        </p>
      )}
      {files.length === 0 ? (
        <p className={NOTE}>Rien à relire · cet agent n’a rien changé</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[280px] flex-none overflow-y-auto border-r border-white/6 p-1.5">
            <FileList
              files={files}
              seen={seen}
              selected={selected}
              onSelect={onSelect}
              onSeen={onSeen}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {shown && <DiffView file={shown} diff={diff?.path === shown.path ? diff : null} />}
          </div>
        </div>
      )}
    </div>
  );
}
