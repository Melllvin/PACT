import { useState, type CSSProperties, type ReactNode } from 'react';
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

const ROW =
  '-mx-3 flex items-center gap-4 rounded-xl border-b border-white/4 px-3 py-4 transition-[background-color] duration-250 hover:bg-white/3 animate-enter motion-reduce:animate-none';
const LIST = 'm-0 flex list-none flex-col border-t border-white/6 p-0';

/** Staggered entry across both lists (FR-042): Déjà ouverts first, then Récents. */
const enterIndex = (index: number) => ({ '--enter-index': String(index) }) as CSSProperties;

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
    <div className="mx-auto grid min-h-full max-w-[1040px] grid-cols-[minmax(0,680px)_300px] justify-center gap-10 px-6 pt-[72px] pb-12">
      <div className="flex min-w-0 flex-col gap-7">
        <div className="flex flex-col gap-3 animate-enter motion-reduce:animate-none">
          <span className={LABEL}>Nouvel onglet</span>
          <h2 className="m-0 text-[40px] leading-[1.05] font-normal tracking-[-0.035em]">
            Ouvrir un workspace
          </h2>
          <p className="m-0 text-[14.5px] leading-[1.55] text-pretty text-muted-foreground">
            Chaque projet garde ses agents, leurs branches et leurs worktrees.
          </p>
        </div>
        <label className="flex h-11 items-center gap-2.5 rounded-xl border border-white/8 bg-white/2 px-3.5 animate-enter focus-within:border-primary/50 motion-reduce:animate-none">
          <span aria-hidden className="text-[14px] text-dim">
            ⌕
          </span>
          <input
            type="search"
            aria-label="Rechercher…"
            placeholder="Rechercher…"
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-foreground outline-none placeholder:text-[#5c5c64]"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>

        {openError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-3.5 py-3 text-[13px]"
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
          <section aria-label="Déjà ouverts" className="flex flex-col gap-3">
            <h3 className={LABEL}>Déjà ouverts</h3>
            <ul className={LIST}>
              {open.map((workspace, index) => {
                const waiting = workspace.agents.filter(
                  (a) => a.state === 'awaiting-answer',
                ).length;
                return (
                  <li key={workspace.id} className={ROW} style={enterIndex(index)}>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <h4 className="m-0 text-[15px] font-medium tracking-[-0.01em]">
                        {workspace.name}
                      </h4>
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
                          className="ml-1.5 font-mono text-[12px] text-waiting"
                          aria-label={`${plural(waiting, 'agent')} en attente`}
                        >
                          ◆ {waiting}
                        </span>
                      )}
                    </span>
                    <Button
                      variant="ghost"
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
          <section aria-label="Récents" className="flex flex-col gap-3">
            <h3 className={LABEL}>Récents</h3>
            <ul className={LIST}>
              {recent.map((project, index) => (
                <li key={project.path} className={ROW} style={enterIndex(open.length + index)}>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h4 className="m-0 text-[15px] font-medium tracking-[-0.01em]">
                      {project.name}
                    </h4>
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
                    variant="ghost"
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

      <aside className="flex flex-col gap-5 pt-[118px]">
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
            className="m-0 rounded-xl border border-destructive/40 bg-destructive/8 px-3.5 py-3 text-[13px]"
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
