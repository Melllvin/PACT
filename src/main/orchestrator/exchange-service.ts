import { randomUUID } from 'node:crypto';
import {
  EXCHANGE_KINDS,
  MAX_EVENTS,
  MAX_EVENT_SUMMARY,
  MAX_JOURNAL,
  MAX_NOTICE,
  exchangeMessageSchema,
  maxText,
  typeOf,
  type ExchangeKind,
  type ExchangeMessage,
  type ExchangeType,
  type Exchanges,
} from '../../shared/exchanges';
import { IpcFailure } from '../../shared/ipc';
import type { AgentState, Workspace } from '../../shared/model';
import type { IntegrationRequest } from '../../shared/orchestrator';

// 007 research R2 — the journal of a workspace: the messages of the agents and the events of PACT,
// each with the agents that have not read it yet. It replaces the in-memory queue of 003.

/** The most a wait holds on (FR-019). */
export const MAX_WAIT_MS = 60_000;

type Store = {
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

type Options = {
  workspaces: Store;
  /** `workspace:exchanges`: the journal as it is now. */
  onChange: (workspaceId: string, exchanges: Exchanges) => void;
};

export type RecordInput = {
  from: string;
  to: string;
  about?: string;
  state?: AgentState;
  kind: ExchangeKind;
  /** Only for a `message`; the other kinds are typed by `typeOf`. */
  type?: ExchangeType;
  text: string;
  integration?: IntegrationRequest | ExchangeMessage['integration'];
  unreadBy?: string[];
};

export type EventSummary = {
  id: string;
  at: string;
  from: string;
  to: string;
  about?: string;
  type: ExchangeType;
  kind: ExchangeKind;
  state?: AgentState;
  summary: string;
  integration?: ExchangeMessage['integration'];
};

export type ReadResult = { events: EventSummary[]; remaining: number };
export type WaitResult = ReadResult & { timedOut: boolean; replaced?: true };

type Waiting = {
  workspaceId: string;
  readerId: string;
  agentIds: readonly string[] | undefined;
  resolve: (result: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const summaryOf = (m: ExchangeMessage): EventSummary => ({
  id: m.id,
  at: m.at,
  from: m.from,
  to: m.to,
  ...(m.about === undefined ? {} : { about: m.about }),
  type: m.type,
  kind: m.kind,
  ...(m.state === undefined ? {} : { state: m.state }),
  summary: m.text.slice(0, MAX_EVENT_SUMMARY),
  ...(m.integration === undefined ? {} : { integration: m.integration }),
});

const notFound = (what: string) => new IpcFailure('NOT_FOUND', what);

export class ExchangeService {
  private readonly waits = new Map<string, Waiting>();
  private readonly listeners: ((workspaceId: string, message: ExchangeMessage) => void)[] = [];

  constructor(private readonly options: Options) {}

  /** The workspace an agent belongs to, if it is still open. */
  workspaceOf(agentId: string): string | undefined {
    return this.options.workspaces.list().find((ws) => ws.agents.some((a) => a.id === agentId))?.id;
  }

  /** Called after each message is saved, for the wake. */
  onRecorded(listener: (workspaceId: string, message: ExchangeMessage) => void): void {
    this.listeners.push(listener);
  }

  /** Writes a message. An event of PACT is cut to 2000 characters; an agent’s text is refused if too long. */
  async record(workspaceId: string, input: RecordInput): Promise<ExchangeMessage> {
    if (!EXCHANGE_KINDS.includes(input.kind)) {
      throw new IpcFailure('INVALID_INPUT', `Type d’échange inconnu : ${input.kind}.`);
    }
    const limit = maxText(input.kind);
    const cuttable = input.kind !== 'message' && input.kind !== 'instruction';
    if (input.text.length > limit && !cuttable) {
      throw new IpcFailure(
        'INVALID_INPUT',
        `Texte trop long : ${String(limit)} caractères au plus.`,
      );
    }
    const message = exchangeMessageSchema.parse({
      id: randomUUID(),
      at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      ...(input.about === undefined ? {} : { about: input.about }),
      ...(input.state === undefined ? {} : { state: input.state }),
      type: typeOf(input.kind, input.type),
      kind: input.kind,
      text: cuttable ? input.text.slice(0, MAX_NOTICE) : input.text,
      ...(input.integration === undefined ? {} : { integration: input.integration }),
      unreadBy: input.unreadBy ?? [input.to],
    });
    const updated = await this.options.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      exchanges: { ...ws.exchanges, messages: evict([...ws.exchanges.messages, message]) },
    }));
    this.options.onChange(workspaceId, updated.exchanges);
    for (const listener of this.listeners) listener(workspaceId, message);
    for (const waiting of [...this.waits.values()]) {
      if (waiting.workspaceId === workspaceId) void this.attempt(waiting);
    }
    return message;
  }

  /** The 20 most recent unread of `readerId`, and what remains; they are marked read. */
  async read(workspaceId: string, readerId: string): Promise<ReadResult> {
    return (await this.take(workspaceId, readerId, undefined)) ?? { events: [], remaining: 0 };
  }

  /** The whole message; only to its sender, its recipient and the orchestrator. Changes no reading. */
  detail(workspaceId: string, readerId: string, messageId: string): Promise<ExchangeMessage> {
    const ws = this.options.workspaces.get(workspaceId);
    const message = ws?.exchanges.messages.find((m) => m.id === messageId);
    if (!ws || !message) return Promise.reject(notFound('Événement introuvable.'));
    const orchestrator = ws.agents.some((a) => a.id === readerId && a.role === 'orchestrator');
    if (!orchestrator && readerId !== message.from && readerId !== message.to) {
      return Promise.reject(new IpcFailure('INVALID_INPUT', 'Cet événement ne te concerne pas.'));
    }
    return Promise.resolve(message);
  }

  /** Unread at once, or the next message, 60 s at most; one wait at a time per reader. */
  wait(
    workspaceId: string,
    readerId: string,
    agentIds: readonly string[] | undefined,
    timeoutMs: number,
  ): Promise<WaitResult> {
    this.end(readerId, { events: [], remaining: 0, timedOut: false, replaced: true });
    return new Promise((resolve) => {
      const waiting: Waiting = {
        workspaceId,
        readerId,
        agentIds,
        resolve,
        timer: setTimeout(
          () => {
            this.end(readerId, { events: [], remaining: 0, timedOut: true });
          },
          Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS),
        ),
      };
      this.waits.set(readerId, waiting);
      void this.attempt(waiting);
    });
  }

  /** The orchestrator restarts or is gone: its wait ends empty. */
  cancelWait(readerId: string): void {
    this.end(readerId, { events: [], remaining: 0, timedOut: false, replaced: true });
  }

  async decide(
    workspaceId: string,
    escalationId: string,
    decision: 'resume' | 'cut',
  ): Promise<void> {
    const ws = this.options.workspaces.get(workspaceId);
    if (!ws?.exchanges.escalations.some((e) => e.id === escalationId)) {
      throw notFound('Escalade introuvable.');
    }
    const updated = await this.options.workspaces.update(workspaceId, (current) => ({
      ...current,
      exchanges: {
        ...current.exchanges,
        escalations:
          decision === 'resume'
            ? current.exchanges.escalations.filter((e) => e.id !== escalationId)
            : current.exchanges.escalations.map((e) =>
                e.id === escalationId ? { ...e, state: 'cut' as const } : e,
              ),
      },
    }));
    this.options.onChange(workspaceId, updated.exchanges);
  }

  /** A closed agent reads nothing any more, and its pairs are free. */
  async forget(workspaceId: string, agentId: string): Promise<void> {
    if (!this.options.workspaces.get(workspaceId)) return;
    this.cancelWait(agentId);
    const updated = await this.options.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      exchanges: {
        messages: ws.exchanges.messages.map((m) =>
          m.unreadBy.includes(agentId)
            ? { ...m, unreadBy: m.unreadBy.filter((id) => id !== agentId) }
            : m,
        ),
        escalations: ws.exchanges.escalations.filter((e) => !e.agents.includes(agentId)),
      },
    }));
    this.options.onChange(workspaceId, updated.exchanges);
  }

  /**
   * Picks the unread of the reader inside the update, which is synchronous: two readers cannot
   * take the same event. `guard` lets a wait refuse once it has ended.
   */
  private async take(
    workspaceId: string,
    readerId: string,
    agentIds: readonly string[] | undefined,
    guard: () => boolean = () => true,
  ): Promise<ReadResult | null> {
    if (!this.options.workspaces.get(workspaceId)) return null;
    let result: ReadResult | null = null;
    const updated = await this.options.workspaces.update(workspaceId, (ws) => {
      if (!guard()) return ws;
      const unread = ws.exchanges.messages.filter(
        (m) =>
          m.unreadBy.includes(readerId) &&
          (agentIds === undefined || agentIds.includes(m.about ?? m.from)),
      );
      const picked = unread.slice(-MAX_EVENTS);
      result = { events: picked.map(summaryOf), remaining: unread.length - picked.length };
      if (picked.length === 0) return ws;
      const ids = new Set(picked.map((m) => m.id));
      return {
        ...ws,
        exchanges: {
          ...ws.exchanges,
          messages: ws.exchanges.messages.map((m) =>
            ids.has(m.id) ? { ...m, unreadBy: m.unreadBy.filter((id) => id !== readerId) } : m,
          ),
        },
      };
    });
    if ((result as ReadResult | null)?.events.length) {
      this.options.onChange(workspaceId, updated.exchanges);
    }
    return result;
  }

  private async attempt(waiting: Waiting): Promise<void> {
    const active = () => this.waits.get(waiting.readerId) === waiting;
    const result = await this.take(waiting.workspaceId, waiting.readerId, waiting.agentIds, active);
    if (result && result.events.length > 0 && active()) {
      this.end(waiting.readerId, { ...result, timedOut: false });
    }
  }

  private end(readerId: string, result: WaitResult) {
    const waiting = this.waits.get(readerId);
    if (!waiting) return;
    this.waits.delete(readerId);
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }
}

/** R2 — over the bound, the oldest message read by everyone goes first, else the oldest. */
function evict(messages: ExchangeMessage[]): ExchangeMessage[] {
  if (messages.length <= MAX_JOURNAL) return messages;
  const read = messages.findIndex((m) => m.unreadBy.length === 0);
  const drop = read === -1 ? 0 : read;
  return messages.filter((_, index) => index !== drop);
}
