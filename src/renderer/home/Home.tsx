import { useState, type ReactNode } from 'react';
import type { IpcError } from '../../shared/ipc';
import type { RecentProject, Workspace } from '../../shared/model';
import { CloneDialog } from './CloneDialog';
import { DropZone } from './DropZone';
import { LABEL, META } from './styles';
import { Button } from '@/components/ui/button';

export type OpenError = IpcError & { path: string };
export type CloneStatus =
  { status: 'running'; percent: number; phase: string } | { status: 'failed'; message: string };

export type HomeProps = {
  workspaces: Workspace[];
  recents: RecentProject[];
  now: Date;
  openError: OpenError | null;
  clone: CloneStatus | null;
  onGoTo: (id: string) => void;
  onOpenPath: (path: string) => void;
  onInitRepo: (path: string) => void;
  onPickRepository: () => void;
  onPickCloneDestination: () => Promise<string | null>;
  onClone: (url: string, destination: string) => void;
  getPathForFile: (file: File) => string;
  /** Under « Autre dépôt », in the right column: the detected agents and the legend (1a). */
  aside?: ReactNode;
};

const CARD = 'flex items-center gap-3.5 rounded-lg border border-border bg-card px-3.5 py-[11px]';
const LIST = 'm-0 flex list-none flex-col gap-2 p-0';

const DAY_MS = 86_400_000;

/** Case- and accent-insensitive search key. */
const searchKey = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const plural = (count: number, word: string) => `${String(count)} ${word}${count > 1 ? 's' : ''}`;

function lastOpened(iso: string, now: Date) {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
  return days <= 0 ? 'ouvert aujourd’hui' : `ouvert il y a ${String(days)} j`;
}

/** Home tab (screen 1a): open workspaces, recents, drop zone, picker and clone (FR-003). */
export function Home(props: HomeProps) {
  const { workspaces, recents, now, openError, clone } = props;
  const [query, setQuery] = useState('');
  const [cloning, setCloning] = useState(false);

  const matches = (name: string, path: string) =>
    searchKey(`${name} ${path}`).includes(searchKey(query.trim()));
  const openPaths = new Set(workspaces.map((w) => w.path));
  const open = workspaces.filter((w) => matches(w.name, w.path));
  const recent = recents.filter((r) => !openPaths.has(r.path) && matches(r.name, r.path));

  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)_300px] gap-[18px] px-10 py-7">
      <div className="flex min-w-0 flex-col gap-3.5">
        <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Ouvrir un workspace</h2>
        <input
          type="search"
          aria-label="Rechercher…"
          placeholder="⌕ Rechercher…"
          className="rounded-[5px] border border-border bg-[#0a0d12] px-2.5 py-[7px] text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />

        {openError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-destructive px-3 py-2.5 text-[12.5px]"
          >
            <p className="m-0">{openError.message}</p>
            {openError.code === 'NOT_A_REPO' && (
              <Button
                onClick={() => {
                  props.onInitRepo(openError.path);
                }}
              >
                Initialiser un dépôt ici
              </Button>
            )}
          </div>
        )}

        {open.length > 0 && (
          <section aria-label="Déjà ouverts" className="flex flex-col gap-2">
            <h3 className={LABEL}>Déjà ouverts</h3>
            <ul className={LIST}>
              {open.map((workspace) => {
                const waiting = workspace.agents.filter(
                  (a) => a.state === 'awaiting-answer',
                ).length;
                return (
                  <li key={workspace.id} className={`${CARD} py-3`}>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <h4 className="m-0 text-[15px] font-semibold">{workspace.name}</h4>
                      <p className={`${META} truncate`}>
                        {workspace.path} · {workspace.mainBranch} ·{' '}
                        {plural(workspace.agents.length, 'worktree')}
                      </p>
                    </div>
                    <span className="flex items-center gap-1">
                      {workspace.agents.map((agent) => (
                        <span
                          key={agent.id}
                          role="img"
                          aria-label={`Agent ${String(agent.position)}`}
                          className="size-2.5 flex-none rounded-full"
                          style={{ background: `var(--agent-${agent.color})` }}
                        />
                      ))}
                      {waiting > 0 && (
                        <span
                          className="ml-1.5 font-mono text-[11px] text-waiting"
                          aria-label={`${plural(waiting, 'agent')} en attente`}
                        >
                          ◆ {waiting}
                        </span>
                      )}
                    </span>
                    <Button
                      onClick={() => {
                        props.onGoTo(workspace.id);
                      }}
                    >
                      Aller à l’onglet
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {recent.length > 0 && (
          <section aria-label="Récents" className="flex flex-col gap-2">
            <h3 className={LABEL}>Récents</h3>
            <ul className={LIST}>
              {recent.map((project) => (
                <li key={project.path} className={CARD}>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h4 className="m-0 text-[14px] font-semibold">{project.name}</h4>
                    <p className={`${META} truncate`}>
                      {project.path} · {project.branch}
                    </p>
                  </div>
                  <span className={META}>
                    {project.keptWorktrees > 0
                      ? `${plural(project.keptWorktrees, 'worktree')} ${
                          project.keptWorktrees > 1 ? 'conservés' : 'conservé'
                        }`
                      : lastOpened(project.lastOpenedAt, now)}
                  </span>
                  <Button
                    onClick={() => {
                      props.onOpenPath(project.path);
                    }}
                  >
                    Ouvrir
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="flex flex-col gap-3.5">
        <section aria-label="Autre dépôt">
          <DropZone
            getPathForFile={props.getPathForFile}
            onDropPath={props.onOpenPath}
            onPick={props.onPickRepository}
            onClone={() => {
              setCloning(true);
            }}
          />
        </section>

        {clone?.status === 'running' && (
          <div className="flex flex-col gap-1">
            <progress
              aria-label="Clonage"
              max={100}
              value={clone.percent}
              aria-valuenow={clone.percent}
              className="w-full accent-(--action)"
            />
            <span className={META}>
              {clone.phase} · {clone.percent} %
            </span>
          </div>
        )}
        {clone?.status === 'failed' && (
          <p
            role="alert"
            className="m-0 rounded-md border border-destructive px-3 py-2.5 text-[12.5px]"
          >
            {clone.message}
          </p>
        )}
        {props.aside}
      </aside>

      {cloning && (
        <CloneDialog
          onPickDestination={props.onPickCloneDestination}
          onClone={(url, destination) => {
            setCloning(false);
            props.onClone(url, destination);
          }}
          onCancel={() => {
            setCloning(false);
          }}
        />
      )}
    </div>
  );
}
