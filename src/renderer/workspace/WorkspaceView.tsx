import { useState } from 'react';
import { MAX_AGENTS, type CliDefinition, type Workspace } from '../../shared/model';
import { deriveTodos } from '../../shared/todo';
import { Toolbar } from '../app/Toolbar';
import { FocusView } from '../focus/FocusView';
import { FreeTerminalTile } from '../tiles/FreeTerminalTile';
import { Tile } from '../tiles/Tile';
import { TileGrid } from '../tiles/TileGrid';
import { TodoColumn } from '../todo/TodoColumn';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import { EmptyWorkspace } from './EmptyWorkspace';
import styles from './workspace.module.css';

/** The tile actions, each about one agent (FR-024, FR-037). */
export type AgentActions = {
  /** `always`: « Toujours pour ce worktree », from the Focus (FR-034). */
  onAnswer: (agentId: string, answer: 'allow' | 'deny', always?: boolean) => void;
  onResume: (agentId: string) => void;
  onRestart: (agentId: string) => void;
  onLog: (agentId: string) => void;
  /** « Annuler » of « reprise auto à HH:MM » (FR-036). */
  onCancelAutoResume: (agentId: string) => void;
  onClose: (agentId: string) => void;
};

const none = () => undefined;
const NO_ACTIONS: AgentActions = {
  onAnswer: none,
  onResume: none,
  onRestart: none,
  onLog: none,
  onCancelAutoResume: none,
  onClose: none,
};

type Props = {
  workspace: Workspace;
  clis?: CliDefinition[];
  /** Where the tiles find their terminals; without it, tiles show no terminal. */
  terminals?: Pick<TerminalRegistry, 'attach'> | undefined;
  onAddAgents?: () => void;
  actions?: AgentActions;
  /** Why the last tile action was refused. */
  actionError?: string | null;
};

export function WorkspaceView({
  workspace,
  clis = [],
  terminals,
  onAddAgents,
  actions = NO_ACTIONS,
  actionError = null,
}: Props) {
  const available = workspace.status === 'available';
  const launch = available ? onAddAgents : undefined;
  const hasAgents = workspace.agents.length > 0;
  const hasTiles = hasAgents || workspace.freeTerminals.length > 0;
  const agents = [...workspace.agents].sort((a, b) => a.position - b.position);
  const cliName = (id: string) => clis.find((cli) => cli.id === id)?.name ?? id;
  const canAdd = agents.length < MAX_AGENTS;
  const [todoOpen, setTodoOpen] = useState(true);
  const todos = deriveTodos(workspace, cliName);
  // Focus (1p) on one agent; back to the grid when that agent is closed (US5).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = agents.some((agent) => agent.id === focusedId) ? focusedId : null;

  return (
    <>
      {/* The À faire column and its button appear with the first agent (FR-006). */}
      <Toolbar
        todoCount={todos.filter((todo) => todo.kind !== 'info').length}
        showTodo={hasAgents}
        todoOpen={todoOpen}
        onToggleTodo={() => {
          setTodoOpen((open) => !open);
        }}
        onAddAgents={launch}
      />
      <div className={styles.body}>
        <section aria-label={workspace.name} className={styles.stage}>
          {!available && (
            <p role="alert" className={styles.unavailable}>
              Dossier introuvable : {workspace.path}. Le workspace reviendra dès que le dossier sera
              de retour.
            </p>
          )}
          {actionError && (
            <p role="alert" className={styles.unavailable}>
              {actionError}
            </p>
          )}
          {available && !hasTiles && <EmptyWorkspace onAddAgents={launch} />}
          {available && focused && (
            <FocusView
              agents={agents}
              agentId={focused}
              name={cliName}
              terminals={terminals}
              onSelect={setFocusedId}
              onBack={() => {
                setFocusedId(null);
              }}
              {...actions}
            />
          )}
          {available && hasTiles && !focused && (
            <TileGrid onAdd={canAdd ? launch : undefined}>
              {agents.map((agent) => (
                <Tile
                  key={agent.id}
                  agent={agent}
                  name={cliName(agent.cliId)}
                  terminals={terminals}
                  onAnswer={(answer) => {
                    actions.onAnswer(agent.id, answer);
                  }}
                  onResume={() => {
                    actions.onResume(agent.id);
                  }}
                  onRestart={() => {
                    actions.onRestart(agent.id);
                  }}
                  onLog={() => {
                    actions.onLog(agent.id);
                  }}
                  onCancelAutoResume={() => {
                    actions.onCancelAutoResume(agent.id);
                  }}
                  onClose={() => {
                    actions.onClose(agent.id);
                  }}
                  onExpand={() => {
                    setFocusedId(agent.id);
                  }}
                />
              ))}
              {workspace.freeTerminals.map((terminal) => (
                <FreeTerminalTile key={terminal.id} terminal={terminal} terminals={terminals} />
              ))}
            </TileGrid>
          )}
        </section>
        {hasAgents && todoOpen && <TodoColumn todos={todos} agents={agents} {...actions} />}
      </div>
    </>
  );
}
