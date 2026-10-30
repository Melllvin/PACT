import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { choicesFor, resultOf } from '../../shared/conflicts';
import type { ConflictChoice, ConflictFile, ConflictHunk, Integration } from '../../shared/review';
import { cn } from '@/lib/utils';

type Props = {
  integration: Integration;
  mainBranch: string;
  /** The files changed by the agent that merged without conflict. */
  clean: number;
  onResolve: (path: string, hunk: number, choice: ConflictChoice) => void;
  onEdit: (path: string, content: string) => void;
  onOpenInEditor: (path: string) => void;
};

const CHOICE_LABEL: Record<ConflictChoice, string> = {
  main: 'Garder main',
  agent: 'Garder cette version',
  both: 'Les deux',
};

const SIDE = 'min-w-0 flex-1 rounded-lg border border-white/8 bg-black/20';
const SIDE_HEAD =
  'border-b border-white/6 px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground';
const LINES = 'm-0 overflow-x-auto px-2.5 py-1.5 font-mono text-[12px] whitespace-pre';

function Side({ title, lines, note }: { title: string; lines: string[]; note?: string | null }) {
  return (
    <div className={SIDE}>
      <div className={SIDE_HEAD}>{title}</div>
      {note ? (
        <p className="m-0 px-2.5 py-1.5 text-[12px] text-dim">{note}</p>
      ) : (
        <pre className={LINES}>
          {lines.map((line, i) => (
            <div key={i}>{line.replace(/\r$/, '') || ' '}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** One conflict, its two versions side by side and the choices (screen 1q, FR-029). */
function Hunk({
  file,
  hunk,
  label,
  mainBranch,
  onResolve,
  onModify,
}: {
  file: ConflictFile;
  hunk: ConflictHunk;
  label: string;
  mainBranch: string;
  onResolve: (choice: ConflictChoice) => void;
  onModify: () => void;
}) {
  const { short, subject } = file.mainCommit;
  const deletedNote = (side: 'main' | 'agent') =>
    file.binary
      ? 'Fichier binaire'
      : file.deleted === side
        ? side === 'main'
          ? `supprimé dans ${mainBranch}`
          : 'supprimé dans cette version'
        : null;
  return (
    <section
      role="group"
      aria-label={label}
      className="flex flex-col gap-2 rounded-xl border border-white/6 bg-white/2 p-3"
    >
      <h3 className="m-0 font-mono text-[11px] font-normal text-muted-foreground">{label}</h3>
      <div className="flex gap-2">
        <Side
          title={`${mainBranch} · « ${subject} » ${short}`}
          lines={hunk.main}
          note={deletedNote('main')}
        />
        <Side title="cette version" lines={hunk.agent} note={deletedNote('agent')} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choicesFor(file).map((choice) => {
          const pressed = file.edited === null && hunk.resolution === choice;
          return (
            <Button
              key={choice}
              aria-pressed={pressed}
              variant={pressed ? 'accept' : 'outline'}
              onClick={() => {
                onResolve(choice);
              }}
            >
              {CHOICE_LABEL[choice]}
            </Button>
          );
        })}
        {!file.binary && <Button onClick={onModify}>Modifier…</Button>}
      </div>
    </section>
  );
}

/** « Modifier… »: the whole file as resolved so far, in a monospace field (R6). */
function Editor({
  file,
  onSave,
  onClose,
}: {
  file: ConflictFile;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState(() => resultOf(file) || file.merged);
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label={`Contenu de ${file.path}`}
        value={content}
        spellCheck={false}
        onChange={(event) => {
          setContent(event.target.value);
        }}
        className="min-h-[240px] resize-y rounded-[10px] border border-white/8 bg-black/30 p-2.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary/50"
      />
      <div className="flex gap-1.5">
        <Button
          variant="accept"
          onClick={() => {
            onSave(content);
            onClose();
          }}
        >
          Enregistrer
        </Button>
        <Button onClick={onClose}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * The Conflits tab of screen 1q: the files in conflict, and for the one chosen each conflict with
 * main's version and the agent's (FR-027, FR-029).
 */
export function ConflictsTab({
  integration,
  mainBranch,
  clean,
  onResolve,
  onEdit,
  onOpenInEditor,
}: Props) {
  const files = integration.conflicts;
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const file = files.find((f) => f.path === chosen) ?? files.find((f) => !f.resolved) ?? files[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-baseline gap-3 border-b border-white/6 px-3.5 py-2.5">
        <h2 className="m-0 text-[14px] font-medium">Conflits · {files.length}</h2>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[280px] flex-none overflow-y-auto border-r border-white/6 p-1.5">
          <ul aria-label="Fichiers en conflit" className="m-0 flex list-none flex-col gap-0.5 p-0">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={f.path === file?.path}
                  onClick={() => {
                    setChosen(f.path);
                    setEditing(null);
                  }}
                  className={cn(
                    'w-full cursor-pointer truncate rounded-lg px-2 py-1.5 text-left font-mono text-[12px]',
                    f.path === file?.path ? 'bg-white/6 text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span className={f.resolved ? 'text-accept' : 'text-waiting'}>
                    {f.resolved ? '✓' : '⚠'}
                  </span>{' '}
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
          {clean > 0 && (
            <p className="m-0 px-2 py-1.5 font-mono text-[12px] text-dim">✓ {clean} sans conflit</p>
          )}
        </div>
        {file && (
          <div className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
              {file.edited !== null && editing === null && (
                <span className="text-[12px] text-accept">Modifié à la main</span>
              )}
              {!file.binary && (
                <Button
                  onClick={() => {
                    onOpenInEditor(file.path);
                  }}
                >
                  Ouvrir dans l’éditeur
                </Button>
              )}
            </div>
            {editing === file.path ? (
              <Editor
                key={file.path}
                file={file}
                onSave={(content) => {
                  onEdit(file.path, content);
                }}
                onClose={() => {
                  setEditing(null);
                }}
              />
            ) : (
              file.hunks.map((hunk) => (
                <Hunk
                  key={hunk.index}
                  file={file}
                  hunk={hunk}
                  mainBranch={mainBranch}
                  label={
                    file.whole
                      ? `${file.path} · fichier entier`
                      : `${file.path} · conflit ${String(hunk.index + 1)} / ${String(file.hunks.length)} · ligne ${String(hunk.line)}`
                  }
                  onResolve={(choice) => {
                    onResolve(file.path, hunk.index, choice);
                  }}
                  onModify={() => {
                    setEditing(file.path);
                  }}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
