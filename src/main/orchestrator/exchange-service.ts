import { randomUUID } from 'node:crypto';
import {
  EXCHANGE_KINDS,
  MAX_EVENTS,
  MAX_EVENT_SUMMARY,
  MAX_JOURNAL,
  MAX_MESSAGE,
  MAX_NOTICE,
  MAX_ROUND_TRIPS,
  MAX_TURN_MESSAGES,
  canSend,
  exchangeMessageSchema,
  maxText,
  typeOf,
  type ExchangeKind,
  type ExchangeMessage,
  type ExchangeType,
  type Exchanges,
} from '../../shared/exchanges';
import { IpcFailure } from '../../shared/ipc';
import { agentName } from '../../shared/agent-name';
import type { Agent, AgentState, Workspace } from '../../shared/model';
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
  /** R10 — the commit the worktree of an agent is at; a change of it puts a pair’s count at zero. */
  head?: (agentId: string) => Promise<string | null>;
  /** The displayed name of a CLI (« Claude Code »), to let `to` be « Claude Code 3 ». */
  name?: (cliId: string) => string;
};

export type Sent = { message: ExchangeMessage; warning?: string };

/** What PACT remembers of the messages between two agents (not persisted: restarts at zero). */
type PairCount = {
  alternations: number;
  last: string | null;
  heads: [string | null, string | null];
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
  /** Messages written by each agent in its current turn (FR-005). */
  private readonly turns = new Map<string, number>();
  private readonly pairs = new Map<string, PairCount>();

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

  /** The agent started or ended a turn: its count of messages goes back to zero (FR-005). */
  resetTurn(agentId: string): void {
    this.turns.delete(agentId);
  }

  /** A `question` of an agent to the orchestrator; not refused when the orchestrator is in error. */
  ask(workspaceId: string, from: string, text: string): Promise<Sent> {
    return this.deliver(workspaceId, from, undefined, text, undefined);
  }

  /** A `message` of an agent to another, by id or displayed name (FR-001 to FR-007). */
  send(
    workspaceId: string,
    input: { from: string; to: string; text: string; type?: ExchangeType },
  ): Promise<Sent> {
    return this.deliver(workspaceId, input.from, input.to, input.text, input.type);
  }

  private nameOf(agent: Pick<Agent, 'name' | 'cliId' | 'position'>): string {
    return agentName(agent, (cliId) => this.options.name?.(cliId) ?? cliId);
  }

  private async deliver(
    workspaceId: string,
    fromId: string,
    toRef: string | undefined,
    text: string,
    type: ExchangeType | undefined,
  ): Promise<Sent> {
    const invalid = (reason: string) => new IpcFailure('INVALID_INPUT', reason);
    const ws = this.options.workspaces.get(workspaceId);
    if (!ws) throw notFound('Workspace introuvable.');
    const from = ws.agents.find((a) => a.id === fromId);
    if (!from) throw notFound('Tu n’es plus dans ce workspace.');
    const lead = ws.agents.find((a) => a.role === 'orchestrator');
    if (!lead) throw invalid('Aucun orchestrateur dans ce workspace.');
    let to = lead;
    if (toRef !== undefined) {
      const wanted = toRef.trim().toLowerCase();
      const found =
        ws.agents.find((a) => a.id === toRef) ??
        ws.agents.find((a) => this.nameOf(a).toLowerCase() === wanted);
      if (!found) throw invalid(`Aucun agent « ${toRef.slice(0, 60)} » dans ce workspace.`);
      to = found;
      const allowed = canSend(from, to, lead.id);
      if (!allowed.ok) throw invalid(allowed.reason);
    } else if (from.id === lead.id) {
      throw invalid('Tu ne peux pas t’écrire à toi-même (soi-même).');
    }
    if (text.trim() === '') throw invalid('Texte vide.');
    if (text.length > MAX_MESSAGE) {
      throw invalid(`Texte trop long : ${String(MAX_MESSAGE)} caractères au plus.`);
    }
    if ((this.turns.get(from.id) ?? 0) >= MAX_TURN_MESSAGES) {
      throw invalid(
        `Plafond de ${String(MAX_TURN_MESSAGES)} messages par tour atteint : finis ton tour.`,
      );
    }
    const key = [from.id, to.id].sort().join('|');
    if (ws.exchanges.escalations.some((e) => [...e.agents].sort().join('|') === key)) {
      throw invalid(
        'Cet échange est en boucle : en attente de la décision de l’utilisateur (escalade).',
      );
    }
    const copy = toRef !== undefined && to.id !== lead.id && from.id !== lead.id;
    // The commits of the pair, read before the synchronous step below.
    const headOf = async (id: string) => (await this.options.head?.(id).catch(() => null)) ?? null;
    const heads: [string | null, string | null] = [await headOf(from.id), await headOf(to.id)];
    if (!this.options.workspaces.get(workspaceId)) throw notFound('Workspace introuvable.');
    // From here to the write: no await, so two sends of a pair cannot both pass the cap.
    if ((this.turns.get(from.id) ?? 0) >= MAX_TURN_MESSAGES) {
      throw invalid(
        `Plafond de ${String(MAX_TURN_MESSAGES)} messages par tour atteint : finis ton tour.`,
      );
    }
    this.turns.set(from.id, (this.turns.get(from.id) ?? 0) + 1);
    const known = this.pairs.get(key);
    const sorted = [from.id, to.id].sort();
    const headsByAgent = (h: [string | null, string | null]) =>
      sorted.map((id) => (id === from.id ? h[0] : h[1]));
    const now = headsByAgent(heads);
    const before: PairCount =
      known && known.heads.every((h, i) => h === now[i])
        ? known
        : { alternations: 0, last: null, heads: now as PairCount['heads'] };
    const next: PairCount = {
      alternations: before.last === from.id ? before.alternations : before.alternations + 1,
      last: from.id,
      heads: now as PairCount['heads'],
    };
    this.pairs.set(key, next);
    let message: ExchangeMessage;
    try {
      message = await this.record(workspaceId, {
        from: from.id,
        to: to.id,
        kind: toRef === undefined ? 'question' : 'message',
        ...(type === undefined ? {} : { type }),
        text,
        unreadBy: copy ? [to.id, lead.id] : [to.id],
      });
    } catch (error) {
      this.turns.set(from.id, Math.max((this.turns.get(from.id) ?? 1) - 1, 0));
      if (known) this.pairs.set(key, known);
      else this.pairs.delete(key);
      throw error;
    }
    if (next.alternations >= MAX_ROUND_TRIPS * 2) {
      await this.escalate(workspaceId, [from.id, to.id], message.id);
    }
    const state = (toRef === undefined ? lead : to).state;
    const warning =
      state === 'error'
        ? `${toRef === undefined ? 'L’orchestrateur' : 'Le destinataire'} est en erreur : le message l’attend.`
        : state === 'closed'
          ? 'Le destinataire est fermé : le message restera sans lecture.'
          : undefined;
    return { message, ...(warning === undefined ? {} : { warning }) };
  }

  /** The 3rd round trip: the pair is stopped until the user decides (FR-006). */
  private async escalate(
    workspaceId: string,
    agents: [string, string],
    lastMessageId: string,
  ): Promise<void> {
    const sorted = [...agents].sort() as [string, string];
    const updated = await this.options.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      exchanges: {
        ...ws.exchanges,
        escalations: [
          ...ws.exchanges.escalations,
          {
            id: randomUUID(),
            agents: sorted,
            lastMessageId,
            state: 'pending' as const,
            at: new Date().toISOString(),
          },
        ],
      },
    }));
    this.options.onChange(workspaceId, updated.exchanges);
    await this.journalPair(
      workspaceId,
      sorted,
      'exchange-escalated',
      (a, b) =>
        `Échange en boucle entre ${a} et ${b} : ${String(MAX_ROUND_TRIPS)} allers-retours. En attente de la décision de l’utilisateur.`,
    );
  }

  /** R3 — an `action` for the orchestrator: what PACT did about a pair of agents. */
  private async journalPair(
    workspaceId: string,
    agents: readonly string[],
    kind: 'exchange-escalated' | 'exchange-decided',
    text: (a: string, b: string) => string,
  ): Promise<void> {
    const ws = this.options.workspaces.get(workspaceId);
    const lead = ws?.agents.find((a) => a.role === 'orchestrator');
    if (!ws || !lead) return;
    const label = (id: string) => {
      const found = ws.agents.find((a) => a.id === id);
      return found ? this.nameOf(found) : id;
    };
    const [a = '', b = ''] = agents.map(label);
    await this.record(workspaceId, { from: 'pact', to: lead.id, kind, text: text(a, b) });
  }

  /** The 20 most recent unread of `readerId`, and what remains; they are marked read. */
  async read(workspaceId: string, readerId: string): Promise<ReadResult> {
    return (await this.take(workspaceId, readerId, undefined)) ?? { events: [], remaining: 0 };
  }

  /** The unread messages of a reader, whole, the most recent `limit` of them; nothing is read. */
  unreadOf(workspaceId: string, readerId: string, limit = 50): ExchangeMessage[] {
    const ws = this.options.workspaces.get(workspaceId);
    return (ws?.exchanges.messages ?? [])
      .filter((m) => m.unreadBy.includes(readerId))
      .slice(-limit);
  }

  /** The reader has read these messages by another way than `get_events` (the file of 007 R11). */
  async markRead(workspaceId: string, readerId: string, ids: readonly string[]): Promise<void> {
    if (!this.options.workspaces.get(workspaceId) || ids.length === 0) return;
    const read = new Set(ids);
    const updated = await this.options.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      exchanges: {
        ...ws.exchanges,
        messages: ws.exchanges.messages.map((m) =>
          read.has(m.id) ? { ...m, unreadBy: m.unreadBy.filter((id) => id !== readerId) } : m,
        ),
      },
    }));
    this.options.onChange(workspaceId, updated.exchanges);
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
    const escalation = this.options.workspaces
      .get(workspaceId)
      ?.exchanges.escalations.find((e) => e.id === escalationId);
    if (!escalation) throw notFound('Escalade introuvable.');
    if (decision === 'resume') this.pairs.delete([...escalation.agents].sort().join('|'));
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
    await this.journalPair(
      workspaceId,
      escalation.agents,
      'exchange-decided',
      (a, b) =>
        `Échange entre ${a} et ${b} : ${decision === 'resume' ? 'reprise autorisée' : 'coupé'} par l’utilisateur.`,
    );
  }

  /** A closed agent reads nothing any more, and its pairs are free. */
  async forget(workspaceId: string, agentId: string): Promise<void> {
    if (!this.options.workspaces.get(workspaceId)) return;
    this.cancelWait(agentId);
    this.turns.delete(agentId);
    for (const key of [...this.pairs.keys()]) {
      if (key.split('|').includes(agentId)) this.pairs.delete(key);
    }
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
   * take the same event. `taken` runs in that same step, so a wait answers at once and never loses
   * what it marked read to a slow write of the file; `guard` lets a wait refuse once it has ended.
   */
  private async take(
    workspaceId: string,
    readerId: string,
    agentIds: readonly string[] | undefined,
    {
      guard = () => true,
      taken,
    }: { guard?: () => boolean; taken?: (result: ReadResult) => void } = {},
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
      taken?.(result);
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
    await this.take(waiting.workspaceId, waiting.readerId, waiting.agentIds, {
      guard: () => this.waits.get(waiting.readerId) === waiting,
      taken: (result) => {
        this.end(waiting.readerId, { ...result, timedOut: false });
      },
    });
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
