import type { CliDefinition, Workspace } from '../../shared/model';
import { Toolbar } from '../app/Toolbar';
import { AgentTile } from '../tiles/AgentTile';
import { TerminalView } from '../tiles/TerminalView';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import tiles from '../tiles/tiles.module.css';
import { EmptyWorkspace } from './EmptyWorkspace';
import styles from './workspace.module.css';

type Props = {
  workspace: Workspace;
  clis?: CliDefinition[];
  /** Where the tiles find their terminals; without it, tiles show no terminal. */
  terminals?: Pick<TerminalRegistry, 'attach'> | undefined;
  onAddAgents?: () => void;
};

export function WorkspaceView({ workspace, clis = [], terminals, onAddAgents }: Props) {
  const available = workspace.status === 'available';
  const launch = available ? onAddAgents : undefined;
  const hasAgents = workspace.agents.length > 0;
  const hasTiles = hasAgents || workspace.freeTerminals.length > 0;
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  const cliName = (id: string) => clis.find((cli) => cli.id === id)?.name ?? id;

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
        {available && !hasTiles && <EmptyWorkspace onAddAgents={launch} />}
        {available && hasTiles && (
          <div className={tiles.grid}>
            {agents.map((agent) => (
              <AgentTile
                key={agent.id}
                agent={agent}
                name={cliName(agent.cliId)}
                terminals={terminals}
              />
            ))}
            {workspace.freeTerminals.map((terminal) => (
              <article key={terminal.id} aria-label="Terminal libre" className={tiles.tile}>
                <header className={tiles.header}>
                  <strong>Terminal libre</strong>
                  <span className={tiles.meta}>{terminal.cwd}</span>
                </header>
                {terminals && (
                  <TerminalView
                    termId={terminal.id}
                    registry={terminals}
                    label={`Shell dans ${terminal.cwd}`}
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
