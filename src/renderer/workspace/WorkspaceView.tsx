import type { Workspace } from '../../shared/model';
import { Toolbar } from '../app/Toolbar';
import { EmptyWorkspace } from './EmptyWorkspace';
import styles from './workspace.module.css';

type Props = { workspace: Workspace; onAddAgents?: () => void };

export function WorkspaceView({ workspace, onAddAgents }: Props) {
  const available = workspace.status === 'available';
  const launch = available ? onAddAgents : undefined;
  const hasAgents = workspace.agents.length > 0;

  return (
    <>
      {/* The À faire column and its button appear with the first agent (FR-006). */}
      <Toolbar todoCount={0} showTodo={hasAgents} onAddAgents={launch} />
      <section aria-label={workspace.name} className={styles.stage}>
        {!available && (
          <p role="alert" className={styles.unavailable}>
            Dossier introuvable : {workspace.path}. Le workspace reviendra dès que le dossier sera
            de retour.
          </p>
        )}
        {available && !hasAgents && <EmptyWorkspace onAddAgents={launch} />}
      </section>
    </>
  );
}
