import type { IpcEvent, IpcEventChannel, IpcInput } from '../../shared/ipc';
import type { Agent } from '../../shared/model';
import type { LaunchRequest } from '../agents/agent-manager';
import type { CliRegistry } from '../agents/cli-registry';
import type { PermissionChoice } from '../agents/permission-service';

// T064 — US2 channels (contracts/ipc.md). `term:write` and `term:resize` come with them: the user
// types the first prompt in the agent's terminal (FR-018). T074 — the US3 tile actions. T109 — US7.

type Dependencies = {
  registry: Pick<CliRegistry, 'add' | 'detect'>;
  permissions: { set(choice: PermissionChoice): Promise<void> };
  agents: {
    launch(request: LaunchRequest): Promise<Agent[]>;
    answer(id: string, answer: 'allow' | 'deny', always: boolean): Promise<void>;
    resume(id: string): Promise<void>;
    restart(id: string): Promise<void>;
    close(id: string, options: { removeWorktree: boolean }): Promise<void>;
    log(id: string): string;
    cancelAutoResume(id: string): Promise<void>;
    typed(id: string, data: string): void;
  };
  freeTerminals: { open(workspaceId: string, count: number): Promise<unknown> };
  pty: {
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
};

export function createAgentServices({
  registry,
  permissions,
  agents,
  freeTerminals,
  pty,
}: Dependencies) {
  return {
    'cli:redetect': () => registry.detect(),
    'cli:add': (cli: IpcInput<'cli:add'>) => registry.add(cli),
    'permission:set': (choice: PermissionChoice) => permissions.set(choice),
    /** Agents first: a refused batch (LIMIT, conflicts) opens nothing at all. */
    async 'agents:launch'({
      workspaceId,
      agents: drafts,
      freeTerminals: count,
      counters,
    }: IpcInput<'agents:launch'> & { counters: LaunchRequest['counters'] }) {
      const launched = await agents.launch({ workspaceId, agents: drafts, counters });
      await freeTerminals.open(workspaceId, count);
      return launched;
    },
    'agent:answer': ({ agentId, answer, always }: IpcInput<'agent:answer'>) =>
      agents.answer(agentId, answer, always ?? false),
    'agent:resume': ({ agentId }: IpcInput<'agent:resume'>) => agents.resume(agentId),
    'agent:restart': ({ agentId }: IpcInput<'agent:restart'>) => agents.restart(agentId),
    'agent:close': ({ agentId, removeWorktree }: IpcInput<'agent:close'>) =>
      agents.close(agentId, { removeWorktree }),
    'agent:log': ({ agentId }: IpcInput<'agent:log'>) => agents.log(agentId),
    'agent:cancelAutoResume': ({ agentId }: IpcInput<'agent:cancelAutoResume'>) =>
      agents.cancelAutoResume(agentId),
    'term:write': ({ termId, data }: IpcInput<'term:write'>) => {
      pty.write(termId, data);
      agents.typed(termId, data);
    },
    'term:resize': ({ termId, cols, rows }: IpcInput<'term:resize'>) => {
      pty.resize(termId, cols, rows);
    },
  };
}

type TerminalSource = {
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (id: string, code: number) => void): () => void;
};
type Emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => void;

/** Terminal output reaches the renderer already grouped by frame (PtyManager, research.md R2). */
export function forwardTerminalEvents(source: TerminalSource, emit: Emit): void {
  source.onData((termId, data) => {
    emit('term:data', { termId, data });
  });
  source.onExit((termId, code) => {
    emit('term:exit', { termId, code });
  });
}
