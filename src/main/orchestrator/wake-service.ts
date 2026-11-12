import {
  HELD_INPUT_NOTICE_MS,
  MAX_WAKES_PER_HOUR,
  WAKE_GROUP_MS,
  pointerText,
  type ExchangeMessage,
} from '../../shared/exchanges';
import type { Agent, Workspace } from '../../shared/model';
import type { AgentManager } from '../agents/agent-manager';
import { eventsNote } from './agent-tools';
import type { ExchangeService } from './exchange-service';

// 007 research R4 (without the hooks, phase 4), R7, R11 — the wake of an agent: the action events
// written for it are grouped for 5 s, then ONE line is typed, a pointer that holds no word of any
// text. The agent reads the events itself (`get_events`), so a text of an agent never reaches
// another agent's prompt.

const HOUR_MS = 3_600_000;
/** How often a wake held by the cap or the usage cut is looked at again. */
const CHECK_MS = 30_000;

type Notice = 'input' | 'cap' | null;
/** Why a wake waits: the state of the agent, its prompt, the cap of the hour, the usage cut. */
type Reason = 'state' | 'input' | 'cap' | 'usage';

type Held = {
  reason: Reason;
  since: number;
  /** Raises `input` once the prompt has been busy for 2 minutes. */
  inputTimer: ReturnType<typeof setTimeout> | null;
  noticed: Notice;
};

export type WakeOptions = {
  workspaces: { get(id: string): Workspace | undefined; list(): Workspace[] };
  /** Types the one-line pointer (`AgentManager.sendPrompt`, origin `wake`). */
  type(agentId: string, line: string): unknown;
  /** The prompt of the agent holds something (draft not empty). */
  inputBusy(agentId: string): boolean;
  /** `Agent.wakeNotice`, saved and announced. */
  setNotice(agentId: string, notice: Notice): void;
  /** 009 R13 — an account of this CLI is paused, or has a window at its stop threshold. */
  usageHeld(cliId: string): boolean;
  /**
   * R11 — an agent without MCP reads its events in `.pact/events.md`: `write` puts the unread there
   * in full and counts them as read. Absent: every agent reads by `get_events`.
   */
  file?: { applies(agent: Agent): boolean; write(agent: Agent): Promise<void> };
};

export class WakeService {
  private readonly windows = new Map<string, ReturnType<typeof setTimeout>>();
  /** The messages already pointed to, per agent: not announced twice (memory only). */
  private readonly announced = new Map<string, Set<string>>();
  private readonly held = new Map<string, Held>();
  private readonly wakes = new Map<string, number[]>();
  private checker: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WakeOptions) {}

  /** A message was recorded: an action event for its recipient opens a window of 5 s. */
  notify(_workspaceId: string, message: ExchangeMessage): void {
    if (message.type !== 'action') return;
    this.openWindow(message.to);
  }

  /** The state or the prompt of the agent changed: a wake that was held tries again. */
  agentChanged(agentId: string): void {
    if (!this.held.has(agentId) || this.windows.has(agentId)) return;
    this.attempt(agentId, false);
  }

  /**
   * 007 R1, R4 — the reply of a hook of an agent at work: the pointer it carries, or null. `tool`
   * (PostToolUse) waits for the window of 5 s to be over; `stop` empties it. The cap of the hour and
   * the usage cut hold the hook as they hold a typed wake; the busy prompt does not, since nothing
   * is typed. Never types. An agent without MCP (R11) reads a file that is written asynchronously:
   * its pointer stays typed, at the end of the turn.
   */
  takeForHook(agentId: string, point: 'tool' | 'stop'): string | null {
    const found = this.find(agentId);
    if (!found) return null;
    const { workspace, agent } = found;
    const pending = this.pending(workspace, agentId);
    if (pending.length === 0) {
      this.release(agentId);
      return null;
    }
    if (this.options.file?.applies(agent) === true) return null;
    if (point === 'tool' && this.windows.has(agentId)) return null;
    // 009 FR-004 — a save instruction goes through the cap and the usage cut.
    if (!saving(pending)) {
      if (this.recentWakes(agentId).length >= MAX_WAKES_PER_HOUR) {
        this.hold(agentId, 'cap');
        return null;
      }
      if (this.options.usageHeld(agent.cliId)) {
        this.hold(agentId, 'usage');
        return null;
      }
    }
    this.closeWindow(agentId);
    this.mark(agent, workspace, pending);
    return pointerText(pending.length);
  }

  /** After a restart: the events still unread are announced, as nothing is in memory. */
  restore(): void {
    for (const workspace of this.options.workspaces.list()) {
      for (const agent of workspace.agents) {
        // A notice saved before the restart describes a hold that no longer exists.
        if (agent.wakeNotice) this.options.setNotice(agent.id, null);
        if (this.pending(workspace, agent.id).length > 0) this.openWindow(agent.id);
      }
    }
  }

  /** Wakes now. `urgent` ignores the cap and the usage cut (FR-017), never a busy prompt. */
  deliver(agentId: string, { urgent = false }: { urgent?: boolean } = {}): void {
    this.closeWindow(agentId);
    this.attempt(agentId, urgent);
  }

  dispose(): void {
    for (const timer of this.windows.values()) clearTimeout(timer);
    this.windows.clear();
    for (const held of this.held.values()) {
      if (held.inputTimer) clearTimeout(held.inputTimer);
    }
    this.held.clear();
    if (this.checker) clearTimeout(this.checker);
    this.checker = null;
  }

  private openWindow(agentId: string) {
    if (this.windows.has(agentId)) return;
    this.windows.set(
      agentId,
      setTimeout(() => {
        this.windows.delete(agentId);
        this.attempt(agentId, false);
      }, WAKE_GROUP_MS),
    );
  }

  private closeWindow(agentId: string) {
    const timer = this.windows.get(agentId);
    if (timer) clearTimeout(timer);
    this.windows.delete(agentId);
  }

  private find(agentId: string): { workspace: Workspace; agent: Agent } | undefined {
    for (const workspace of this.options.workspaces.list()) {
      const agent = workspace.agents.find((a) => a.id === agentId);
      if (agent) return { workspace, agent };
    }
    return undefined;
  }

  /** The action events written for the agent, unread, and not pointed to yet. */
  private pending(workspace: Workspace, agentId: string): ExchangeMessage[] {
    const announced = this.announced.get(agentId);
    return workspace.exchanges.messages.filter(
      (m) =>
        m.to === agentId &&
        m.type === 'action' &&
        m.unreadBy.includes(agentId) &&
        !announced?.has(m.id),
    );
  }

  private attempt(agentId: string, urgent: boolean) {
    const found = this.find(agentId);
    if (!found) {
      this.release(agentId);
      return;
    }
    const { workspace, agent } = found;
    const pending = this.pending(workspace, agentId);
    if (pending.length === 0) {
      this.release(agentId);
      return;
    }
    if (agent.state !== 'awaiting-prompt' && agent.state !== 'done') {
      this.hold(agentId, 'state');
      return;
    }
    if (this.options.inputBusy(agentId)) {
      this.hold(agentId, 'input');
      return;
    }
    if (!urgent && !saving(pending)) {
      const recent = this.recentWakes(agentId);
      if (recent.length >= MAX_WAKES_PER_HOUR) {
        this.hold(agentId, 'cap');
        return;
      }
      if (this.options.usageHeld(agent.cliId)) {
        this.hold(agentId, 'usage');
        return;
      }
    }
    this.send(agent, workspace, pending);
  }

  private recentWakes(agentId: string): number[] {
    const now = Date.now();
    const recent = (this.wakes.get(agentId) ?? []).filter((at) => now - at < HOUR_MS);
    this.wakes.set(agentId, recent);
    return recent;
  }

  /** The messages are announced and the wake counts for the cap; the hold and its notice end. */
  private mark(agent: Agent, workspace: Workspace, pending: ExchangeMessage[]) {
    const ids = this.announced.get(agent.id) ?? new Set<string>();
    // Only what the journal still holds is remembered.
    const kept = new Set(workspace.exchanges.messages.map((m) => m.id));
    const next = new Set([...ids].filter((id) => kept.has(id)));
    for (const m of pending) next.add(m.id);
    this.announced.set(agent.id, next);
    this.wakes.set(agent.id, [...this.recentWakes(agent.id), Date.now()]);
    this.release(agent.id);
  }

  private send(agent: Agent, workspace: Workspace, pending: ExchangeMessage[]) {
    this.mark(agent, workspace, pending);
    const file = this.options.file?.applies(agent) === true;
    if (!file) {
      this.options.type(agent.id, pointerText(pending.length));
      return;
    }
    this.options.file
      ?.write(agent)
      .then(() => this.options.type(agent.id, pointerText(pending.length, '.pact/events.md')))
      .catch(() => {
        // Nothing was written: the events are still unread and will be announced again.
        for (const m of pending) this.announced.get(agent.id)?.delete(m.id);
      });
  }

  /** A wake waits: why, and the notices that say it (2 min of busy prompt, the cap once). */
  private hold(agentId: string, reason: Reason) {
    const held = this.held.get(agentId) ?? {
      reason,
      since: Date.now(),
      inputTimer: null,
      noticed: null,
    };
    held.reason = reason;
    this.held.set(agentId, held);
    if (reason === 'input' && held.inputTimer === null && held.noticed !== 'input') {
      const wait = Math.max(0, held.since + HELD_INPUT_NOTICE_MS - Date.now());
      held.inputTimer = setTimeout(() => {
        held.inputTimer = null;
        if (this.held.get(agentId) !== held || held.noticed === 'input') return;
        held.noticed = 'input';
        this.options.setNotice(agentId, 'input');
      }, wait);
    }
    if (reason === 'cap' && held.noticed !== 'cap') {
      held.noticed = 'cap';
      this.options.setNotice(agentId, 'cap');
    }
    this.arm();
  }

  /** The wake goes out or has nothing left to say: its hold and its notice end. */
  private release(agentId: string) {
    const held = this.held.get(agentId);
    if (!held) return;
    if (held.inputTimer) clearTimeout(held.inputTimer);
    this.held.delete(agentId);
    if (held.noticed !== null) this.options.setNotice(agentId, null);
  }

  /** The check every 30 s runs only while a wake is held by the cap or the usage cut. */
  private arm() {
    if (this.checker !== null) return;
    const waiting = [...this.held.values()].some((h) => h.reason === 'cap' || h.reason === 'usage');
    if (!waiting) return;
    this.checker = setTimeout(() => {
      this.checker = null;
      for (const [agentId, held] of [...this.held]) {
        if (held.reason === 'cap' || held.reason === 'usage') this.attempt(agentId, false);
      }
      this.arm();
    }, CHECK_MS);
  }
}

/** 009 FR-004 — a pending `usage-save` makes the wake urgent. */
function saving(pending: readonly ExchangeMessage[]): boolean {
  return pending.some((m) => m.kind === 'usage-save');
}

/** R11 — the text of `.pact/events.md`: the unread events in full, as data reported to the agent. */
export function eventsFileText(messages: readonly ExchangeMessage[]): string {
  const blocks = messages.map(
    (m) => `## ${m.at} · ${m.kind} · de ${m.from === 'pact' ? 'PACT' : m.from}\n\n${m.text}\n`,
  );
  return `# Événements PACT\n\n${eventsNote}\n\n${blocks.join('\n')}`;
}

/** R11 — an agent without MCP reads its events in a file; they count as read once it is written. */
export function eventsFile(deps: {
  exchanges: Pick<ExchangeService, 'unreadOf' | 'markRead'>;
  agents: Pick<AgentManager, 'hasMcp' | 'writeEventsFile'>;
}): NonNullable<WakeOptions['file']> {
  return {
    applies: (agent) => !deps.agents.hasMcp(agent.id),
    write: async (agent) => {
      const messages = deps.exchanges.unreadOf(agent.workspaceId, agent.id);
      await deps.agents.writeEventsFile(agent.id, eventsFileText(messages), () =>
        deps.exchanges.markRead(
          agent.workspaceId,
          agent.id,
          messages.map((m) => m.id),
        ),
      );
    },
  };
}
