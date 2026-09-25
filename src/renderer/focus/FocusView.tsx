import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { Agent } from '../../shared/model';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TerminalView } from '../tiles/TerminalView';
import { TileActions } from '../tiles/TileActions';
import type { TerminalRegistry } from '../tiles/terminal-registry';
import type { AgentActions } from '../workspace/WorkspaceView';
import { AgentPills } from './AgentPills';

type Props = Omit<AgentActions, 'onClose'> & {
  /** Every agent of the workspace, in position order, for the pills. */
  agents: Agent[];
  agentId: string;
  name: (cliId: string) => string;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
  onSelect: (agentId: string) => void;
  onBack: () => void;
};

const TAB =
  'flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-2.5 pb-2 text-[12.5px] ' +
  'data-[state=active]:border-(--agent-color) data-[state=active]:bg-transparent ' +
  'data-[state=active]:font-semibold data-[state=active]:shadow-none after:bg-(--agent-color)';

/**
 * Focus (screen 1p): one agent large, opened by ⤢. Only the Terminal tab exists in this version;
 * Aperçu and Changements are shown disabled. « ‹ Tuiles » or Escape outside the terminal goes
 * back to the grid (US5).
 */
export function FocusView({
  agents,
  agentId,
  name,
  terminals,
  onSelect,
  onBack,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onCancelAutoResume,
}: Props) {
  const terminalBox = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  useLayoutEffect(() => {
    back.current = onBack;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the CLI in its terminal, and to a dialog when one is open.
      if (event.target instanceof Node && terminalBox.current?.contains(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      back.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const title = `${name(agent.cliId)} ${String(agent.position)}`;
  const failed = agent.state === 'error';
  return (
    <section
      data-fx-shield
      aria-label={`Focus : ${title}`}
      data-state={agent.state}
      style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
      className="flex h-full min-h-0 animate-enter flex-col overflow-hidden rounded-[14px] border border-[color-mix(in_srgb,var(--agent-color)_55%,transparent)] bg-surface motion-reduce:animate-none"
    >
      <header className="flex h-12 flex-none items-center gap-3 border-b border-white/6 px-3.5">
        <button
          onClick={onBack}
          className="flex h-7 cursor-pointer items-center rounded-lg border border-white/8 px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:border-white/16 hover:text-foreground"
        >
          ‹ Tuiles
        </button>
        <AgentPills agents={agents} current={agent.id} name={name} onSelect={onSelect} />
        <span aria-hidden className="h-[18px] w-px bg-white/8" />
        <Tabs value="terminal">
          <TabsList variant="line" className="h-auto gap-4 p-0">
            <TabsTrigger value="terminal" className={TAB}>
              Terminal
            </TabsTrigger>
            <TabsTrigger value="preview" disabled className={TAB}>
              Aperçu
            </TabsTrigger>
            <TabsTrigger value="changes" disabled className={TAB}>
              Changements
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-dim">
          ⎇ {agent.branch} · :{agent.port}
        </span>
      </header>
      <div ref={terminalBox} className="flex min-h-0 flex-1 flex-col">
        {terminals && (
          <TerminalView termId={agent.id} registry={terminals} label={`Terminal de ${title}`} />
        )}
      </div>
      <footer className="flex flex-none items-center justify-end gap-2 border-t border-white/6 px-3.5 py-2.5 text-[13px]">
        {failed && agent.lastError && (
          <span className="mr-auto font-mono text-[12px] text-[#f2a0a0]">
            {agent.lastError.message}
          </span>
        )}
        <TileActions
          state={agent.state}
          scheduledResume={agent.scheduledResume}
          onAnswer={(answer) => {
            onAnswer(agent.id, answer);
          }}
          onAlways={() => {
            onAnswer(agent.id, 'allow', true);
          }}
          onResume={() => {
            onResume(agent.id);
          }}
          onRestart={() => {
            onRestart(agent.id);
          }}
          onLog={() => {
            onLog(agent.id);
          }}
          onCancelAutoResume={() => {
            onCancelAutoResume(agent.id);
          }}
        />
      </footer>
    </section>
  );
}
