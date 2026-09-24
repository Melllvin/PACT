import { useState } from 'react';
import type { IpcError } from '../../shared/ipc';
import type { RecentProject, Workspace } from '../../shared/model';
import { CloneDialog } from './CloneDialog';
import { DropZone } from './DropZone';
import styles from './home.module.css';

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
};

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
    <div className={styles.home}>
      <header className={styles.header}>
        <h2>Ouvrir un workspace</h2>
        <input
          type="search"
          aria-label="Rechercher…"
          placeholder="⌕ Rechercher…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </header>

      {openError && (
        <div role="alert" className={styles.alert}>
          <p>{openError.message}</p>
          {openError.code === 'NOT_A_REPO' && (
            <button
              onClick={() => {
                props.onInitRepo(openError.path);
              }}
            >
              Initialiser un dépôt ici
            </button>
          )}
        </div>
      )}

      {open.length > 0 && (
        <section aria-label="Déjà ouverts" className={styles.section}>
          <h3>Déjà ouverts</h3>
          <ul>
            {open.map((workspace) => {
              const waiting = workspace.agents.filter((a) => a.state === 'awaiting-answer').length;
              return (
                <li key={workspace.id} className={styles.row}>
                  <div>
                    <h4>{workspace.name}</h4>
                    <p className={styles.meta}>
                      {workspace.path} · {workspace.mainBranch} ·{' '}
                      {plural(workspace.agents.length, 'worktree')}
                    </p>
                  </div>
                  <span className={styles.pills}>
                    {workspace.agents.map((agent) => (
                      <span
                        key={agent.id}
                        role="img"
                        aria-label={`Agent ${String(agent.position)}`}
                        className={styles.pill}
                        style={{ background: `var(--agent-${agent.color})` }}
                      />
                    ))}
                  </span>
                  {waiting > 0 && (
                    <span
                      className={styles.waiting}
                      aria-label={`${plural(waiting, 'agent')} en attente`}
                    >
                      ◆ {waiting}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      props.onGoTo(workspace.id);
                    }}
                  >
                    Aller à l’onglet
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section aria-label="Récents" className={styles.section}>
          <h3>Récents</h3>
          <ul>
            {recent.map((project) => (
              <li key={project.path} className={styles.row}>
                <div>
                  <h4>{project.name}</h4>
                  <p className={styles.meta}>
                    {project.path} · {project.branch}
                  </p>
                </div>
                <span className={styles.meta}>
                  {project.keptWorktrees > 0
                    ? `${plural(project.keptWorktrees, 'worktree')} ${
                        project.keptWorktrees > 1 ? 'conservés' : 'conservé'
                      }`
                    : lastOpened(project.lastOpenedAt, now)}
                </span>
                <button
                  onClick={() => {
                    props.onOpenPath(project.path);
                  }}
                >
                  Ouvrir
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Autre dépôt" className={styles.section}>
        <h3>Autre dépôt</h3>
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
        <div className={styles.progress}>
          <progress
            aria-label="Clonage"
            max={100}
            value={clone.percent}
            aria-valuenow={clone.percent}
          />
          <span className={styles.meta}>
            {clone.phase} · {clone.percent} %
          </span>
        </div>
      )}
      {clone?.status === 'failed' && (
        <p role="alert" className={styles.alert}>
          {clone.message}
        </p>
      )}

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
