import { nextResume, type Clock } from '../agents/auto-resume';
import type { PauseInfo } from '../agents/agent-manager';
import type { Stores } from '../persistence/store';
import type { RecordInput } from '../orchestrator/exchange-service';
import type { Agent, ScheduledResume } from '../../shared/model';
import { who } from '../../shared/todo';
import type { UsageReading, UsageState } from '../../shared/usage';
import {
  JUMP_STOP_MS,
  limitBands,
  pausedText,
  resumedText,
  saveText,
  type LimitBand,
  type UsageLimitState,
  type UsageOverride,
  type UsageSave,
  type UsageStops,
} from '../../shared/usage-limit';

// 009 R4 to R7, R13 — the stop at a limit of consumption: for each account (CLI + configuration
// folder), the reading is judged window by window. A window near its threshold gets a save
// instruction once per reset; at the threshold the agents of the account are stopped. PACT never
// runs a Git command that writes: the agents commit themselves.

export type UsageLimitOptions = {
  /** The subset of `AgentManager` the service uses. */
  agents: {
    accountAgents(cliId: string, account: string): Agent[];
    pause(agentId: string, pause: PauseInfo): Promise<void>;
    /** R8 — the agents in `paused` of the account, each with its `pause`. */
    pausedAgents(cliId: string, account: string): Agent[];
    /** R8 — `startAgain` in its session; 'blocked' when there is none. */
    resumePaused(agentId: string): Promise<'resumed' | 'blocked'>;
    /** R8, R10 — sets, or with null clears, the scheduled resume of an agent. */
    schedule(agentId: string, resume: ScheduledResume | null): Promise<void>;
  };
  /** R8 — Git is only read: a lock found is reported, never erased. */
  git: { indexLock(worktreePath: string): Promise<string | null> };
  /** The name of a CLI, for the agents the notices list. */
  cliName(cliId: string): string;
  exchanges: { record(workspaceId: string, input: RecordInput): Promise<unknown> };
  wake: { deliver(agentId: string, options?: { urgent?: boolean }): void };
  /** `state.json` holds `usageStops` and `usageLimit`. */
  stores: Pick<Stores, 'state'>;
  clock: Clock;
  /** Whether the workspace resumes by itself (the reset time is then promised in the notice). */
  autoResume(workspaceId: string): Promise<boolean>;
  /** 008 freezes the commit of the agent (R18): no save instruction for it. */
  commitFrozen(agentId: string): boolean;
};

const keyOf = (cliId: string, account: string) => `${cliId}\u0000${account}`;

/** Agents that cannot read an instruction: the ones in error, closed or already stopped. */
const canBeTold = (agent: Agent) =>
  agent.state !== 'error' && agent.state !== 'closed' && agent.state !== 'paused';

/** The stop of agents waiting for the end of their turn, or for 60 s at most (Q8, O5). */
type Deferred = { info: PauseInfo; agents: Map<string, Agent>; timer: unknown };

export class UsageLimitService {
  private readonly options: UsageLimitOptions;
  private stops: UsageStops = {};
  private limit: UsageLimitState = { saves: [], overrides: [], declined: [], resumed: [] };
  private readonly readings = new Map<string, UsageReading>();
  /** The accounts in pause: what the stop of their agents was about. */
  private readonly paused = new Map<string, PauseInfo>();
  private readonly deferred = new Map<string, Deferred>();
  /** Calls are served one after the other: a reading never overtakes the one before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: UsageLimitOptions) {
    this.options = options;
  }

  /** A `usage:state` of `UsageService`. A CLI without a reading is never touched (FR-011). */
  onUsage(state: UsageState): Promise<void> {
    const { reading } = state;
    if (!reading) return Promise.resolve();
    return this.enqueue(() => this.judge(reading));
  }

  /** The agent ended its turn: if its stop waited for that, it is stopped now. */
  turnFinished(agentId: string): Promise<void> {
    if (![...this.deferred.values()].some((d) => d.agents.has(agentId))) return Promise.resolve();
    return this.enqueue(async () => {
      for (const [key, deferred] of [...this.deferred]) {
        const agent = deferred.agents.get(agentId);
        if (!agent) continue;
        // The window may have reset while the stop waited: the whole deferred stop is dropped.
        if (!this.stillStops(key)) {
          this.endDeferred(key);
          continue;
        }
        deferred.agents.delete(agentId);
        if (deferred.agents.size === 0) this.endDeferred(key);
        await this.stop(agent, deferred.info);
      }
    });
  }

  /**
   * O1 — agents were launched, whoever asked. One the user started during a pause of its CLI is
   * covered by an override of its own until the reset; one an orchestrator started is not.
   */
  launched(_workspaceId: string, agents: Agent[]): Promise<void> {
    const byUser = agents.filter((agent) => agent.launchedBy === null);
    if (byUser.length === 0 || this.paused.size === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const added: UsageOverride[] = [];
      for (const agent of byUser) {
        for (const info of this.paused.values()) {
          if (info.cliId !== agent.cliId) continue;
          added.push({
            cliId: info.cliId,
            account: info.account,
            until: info.resumeAt,
            agentId: agent.id,
          });
        }
      }
      if (added.length === 0) return;
      const state = await this.load();
      await this.save({ ...state, overrides: [...state.overrides, ...added] });
    });
  }

  /**
   * R8 — the resume of an account is due. The last reading is read again: a window still at its
   * threshold, with a reset to come, makes the agents wait for that reset (US2 sc.2); else they
   * resume, the orchestrators first. An unknown reset resumes all the same (O2).
   */
  resumeAccount(cliId: string, account: string): Promise<void> {
    return this.enqueue(() => this.resume(cliId, account, false));
  }

  /**
   * R6 « Seuil changé » (US4) — `settings:usageStops` has written the thresholds: every account is
   * judged again on its last reading. A threshold lowered under the consumption is a jump over the
   * band (a save, then the stop in 60 s at most); one raised above every window of an account in
   * pause resumes it.
   */
  setStops(_stops: UsageStops): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      const now = this.options.clock.now();
      for (const [key, reading] of [...this.readings]) {
        const stillStops = limitBands(reading, this.stops, now).some((b) => b.band === 'stop');
        if (this.paused.has(key) && !stillStops) {
          await this.resume(reading.cliId, reading.account, false);
        } else {
          await this.judge(reading);
        }
      }
    });
  }

  /** R10 — « Reprendre » of À faire: the account resumes now, and an override covers it. */
  resumeByHand(cliId: string, account: string): Promise<void> {
    return this.enqueue(() => this.resume(cliId, account, true));
  }

  /**
   * R10 — « Reprendre » on the tile: that agent alone resumes, with an override of its own.
   * `known` is the agent when the caller has it, which a restart of PACT needs: the pauses the
   * service remembers are lost with it.
   */
  resumeAgent(agentId: string, known?: Agent): Promise<void> {
    return this.enqueue(async () => {
      const agent = known ?? this.pausedAgent(agentId);
      const pause = agent?.pause;
      if (!agent || !pause) return;
      const now = this.options.clock.now();
      const state = await this.load();
      await this.save({
        ...state,
        overrides: [
          ...state.overrides.filter((o) => o.agentId !== agentId),
          { cliId: pause.cliId, account: pause.account, until: pause.resumeAt, agentId },
        ],
      });
      const locks = await this.locksOf([agent]);
      const resumed = await this.resumeAll([agent]);
      await this.notify(resumed, locks, now);
      this.forgetIfEmpty(pause.cliId, pause.account);
    });
  }

  /** « Annuler la reprise »: no agent of the account has a scheduled resume; they stay paused. */
  cancelResume(cliId: string, account: string): Promise<void> {
    return this.enqueue(async () => {
      for (const agent of this.options.agents.pausedAgents(cliId, account)) {
        await this.options.agents.schedule(agent.id, null);
      }
    });
  }

  /**
   * R9 — PACT started again: the accounts of the agents persisted as `paused` are in pause again,
   * so the wakes and `launch_agent` hold before any reading comes.
   */
  restorePauses(agents: readonly Agent[]): void {
    for (const { state, pause } of agents) {
      if (state !== 'paused' || !pause) continue;
      const { cliId, account, cause, windows, resumeAt, pausedAt } = pause;
      this.paused.set(keyOf(cliId, account), {
        cliId,
        account,
        cause,
        windows,
        resumeAt,
        pausedAt,
      });
    }
  }

  /** R13 — the wakes of this CLI wait: an account is in pause or at its threshold. */
  usageHeld(cliId: string): boolean {
    const now = this.options.clock.now();
    for (const info of this.paused.values()) {
      if (info.cliId === cliId && !this.accountCovered(info.cliId, info.account, now)) return true;
    }
    for (const reading of this.readings.values()) {
      if (reading.cliId !== cliId || this.accountCovered(cliId, reading.account, now)) continue;
      if (!this.fresh(reading)) continue;
      if (limitBands(reading, this.stops, now).some((b) => b.band === 'stop')) return true;
    }
    return false;
  }

  /** R12 — the pause of an account of this CLI that `launch_agent` must respect, or null. */
  pausedFor(cliId: string): PauseInfo | null {
    const now = this.options.clock.now();
    for (const info of this.paused.values()) {
      if (info.cliId === cliId && !this.accountCovered(info.cliId, info.account, now)) return info;
    }
    return null;
  }

  /** Every account in pause: the launcher of the user warns about them (R12). */
  pauses(): PauseInfo[] {
    return [...this.paused.values()];
  }

  dispose(): void {
    for (const key of [...this.deferred.keys()]) this.endDeferred(key);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<UsageLimitState> {
    const saved = await this.options.stores.state.read();
    this.stops = saved.usageStops;
    this.limit = saved.usageLimit;
    return this.limit;
  }

  private async save(limit: UsageLimitState): Promise<void> {
    this.limit = limit;
    const saved = await this.options.stores.state.read();
    await this.options.stores.state.write({ ...saved, usageLimit: limit });
  }

  /** O2 — whether the reading is more recent than the last resume of its account. */
  private fresh(reading: UsageReading): boolean {
    const last = this.limit.resumed.find(
      (r) => r.cliId === reading.cliId && r.account === reading.account,
    );
    return !last || Date.parse(reading.readAt) > Date.parse(last.at);
  }

  /** An override of the whole account that still holds (R10). */
  private accountCovered(cliId: string, account: string, now: Date): boolean {
    return this.limit.overrides.some(
      (o) => o.cliId === cliId && o.account === account && o.agentId === null && this.holds(o, now),
    );
  }

  private covered(agent: Agent, cliId: string, account: string, now: Date): boolean {
    return this.limit.overrides.some(
      (o) =>
        o.cliId === cliId &&
        o.account === account &&
        (o.agentId === null || o.agentId === agent.id) &&
        this.holds(o, now),
    );
  }

  private holds(override: UsageOverride, now: Date): boolean {
    return override.until === null || Date.parse(override.until) > now.getTime();
  }

  /** One reading of an account: the save instruction, then the stop. */
  private async judge(reading: UsageReading): Promise<void> {
    const { cliId, account } = reading;
    const key = keyOf(cliId, account);
    const now = this.options.clock.now();
    let limit = await this.load();
    this.readings.set(key, reading);
    // O2 — a reading taken before the resume says nothing of the limit since.
    if (!this.fresh(reading)) return;

    const bands = limitBands(reading, this.stops, now);
    // An override ends with its reset; one with no known end, when a reading shows a window reset.
    const reset = bands.some((b) => b.window.reset);
    const overrides = limit.overrides.filter(
      (o) =>
        o.cliId !== cliId ||
        o.account !== account ||
        (o.until === null ? !reset : this.holds(o, now)),
    );
    if (overrides.length !== limit.overrides.length) {
      limit = { ...limit, overrides };
      await this.save(limit);
    }

    const agents = this.options.agents
      .accountAgents(cliId, account)
      .filter((agent) => !this.covered(agent, cliId, account, now));
    const near = bands.filter((b) => b.band !== 'ok');
    if (near.length === 0) return;

    const jumped = await this.instruct(reading, near, agents, now);
    const stopping = near.filter((b) => b.band === 'stop');
    if (stopping.length === 0 || agents.length === 0) return;

    const info = this.pauseInfo(reading, stopping, now);
    const waiting = this.deferred.get(key);
    // The save of this very reading leaves the agents the time to commit.
    if (jumped || waiting) {
      this.defer(key, info, agents);
      return;
    }
    await Promise.all(agents.map((agent) => this.stop(agent, info)));
  }

  /**
   * FR-003 to FR-005 — the save instruction of each window near its threshold, once per reset and
   * per agent. Returns whether a window at its threshold got its first instruction in this very
   * reading (a jump over the band, Q8).
   */
  private async instruct(
    reading: UsageReading,
    near: LimitBand[],
    agents: Agent[],
    now: Date,
  ): Promise<boolean> {
    const { cliId, account } = reading;
    const told = agents.filter((agent) => canBeTold(agent) && !this.options.commitFrozen(agent.id));
    const sends = new Map<string, LimitBand>();
    const entries: UsageSave[] = [];
    let jumped = false;

    for (const band of near) {
      const { window } = band;
      const known = this.limit.saves.find(
        (s) =>
          s.cliId === cliId &&
          s.account === account &&
          s.windowId === window.id &&
          this.stillHolds(s, window.resetsAt, now),
      );
      const recipients = told.filter((agent) => !known?.agentIds.includes(agent.id));
      if (known && recipients.length === 0) continue;
      if (!known && band.band === 'stop') jumped = true;
      for (const agent of recipients) {
        const best = sends.get(agent.id);
        if (!best || window.usedPercent > best.window.usedPercent) sends.set(agent.id, band);
      }
      entries.push({
        cliId,
        account,
        windowId: window.id,
        resetsAt: window.resetsAt,
        at: now.toISOString(),
        agentIds: [...new Set([...(known?.agentIds ?? []), ...recipients.map((a) => a.id)])],
      });
    }

    if (entries.length === 0) return jumped;
    // Written before any instruction goes out: a restart does not send it twice.
    const replaced = (s: UsageSave) =>
      s.cliId === cliId && s.account === account && entries.some((e) => e.windowId === s.windowId);
    await this.save({
      ...this.limit,
      saves: [...this.limit.saves.filter((s) => !replaced(s)), ...entries],
    });

    for (const agent of told) {
      const band = sends.get(agent.id);
      if (!band) continue;
      const { window } = band;
      const text = saveText(
        window.label,
        Math.round(window.usedPercent),
        band.stop,
        band.band === 'stop',
      );
      try {
        await this.options.exchanges.record(agent.workspaceId, {
          from: 'pact',
          to: agent.id,
          kind: 'usage-save',
          text,
        });
        this.options.wake.deliver(agent.id, { urgent: true });
      } catch {
        // The agent is gone (closed meanwhile): nothing to tell.
      }
    }
    return jumped;
  }

  /** An instruction stands for its reset: until the time passes, or a reading shows a later one. */
  private stillHolds(save: UsageSave, resetsAt: string | null, now: Date): boolean {
    if (save.resetsAt === null) return resetsAt === null;
    if (Date.parse(save.resetsAt) <= now.getTime()) return false;
    return resetsAt === null || Date.parse(resetsAt) <= Date.parse(save.resetsAt);
  }

  private pauseInfo(reading: UsageReading, stopping: LimitBand[], now: Date): PauseInfo {
    const windows = stopping.map(({ window }) => ({
      id: window.id,
      label: window.label,
      percent: Math.round(window.usedPercent),
      resetsAt: window.resetsAt,
    }));
    const times = windows.map((w) => w.resetsAt);
    const latest = times.every((t) => t !== null)
      ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
      : null;
    return {
      cliId: reading.cliId,
      account: reading.account,
      cause: 'threshold',
      windows,
      resumeAt: latest,
      pausedAt: now.toISOString(),
    };
  }

  /** Q8, O5 — each agent stops at the end of its turn, all of them at 60 s at the latest. */
  private defer(key: string, info: PauseInfo, agents: Agent[]) {
    const current = this.deferred.get(key);
    const deferred: Deferred = current ?? {
      info,
      agents: new Map(),
      timer: this.options.clock.setTimeout(() => {
        void this.enqueue(() => this.expire(key));
      }, JUMP_STOP_MS),
    };
    for (const agent of agents) deferred.agents.set(agent.id, agent);
    this.deferred.set(key, deferred);
  }

  private async expire(key: string) {
    const deferred = this.deferred.get(key);
    if (!deferred) return;
    this.deferred.delete(key);
    // The window may have reset while the stop waited: nothing left to stop for.
    if (!this.stillStops(key)) return;
    await Promise.all(
      [...deferred.agents.values()].map((agent) => this.stop(agent, deferred.info)),
    );
  }

  /** The last reading of the account still asks for a stop (or there is none to say otherwise). */
  private stillStops(key: string): boolean {
    const reading = this.readings.get(key);
    if (!reading) return true;
    return limitBands(reading, this.stops, this.options.clock.now()).some((b) => b.band === 'stop');
  }

  private endDeferred(key: string) {
    const deferred = this.deferred.get(key);
    if (!deferred) return;
    this.options.clock.clearTimeout(deferred.timer);
    this.deferred.delete(key);
  }

  /** The reset a window still at its threshold waits for, or null: the account may resume. */
  private waitFor(key: string, now: Date): string | null {
    const reading = this.readings.get(key);
    if (!reading || !this.fresh(reading)) return null;
    const times = limitBands(reading, this.stops, now)
      .filter((b) => b.band === 'stop')
      .flatMap((b) => (b.window.resetsAt === null ? [] : [b.window.resetsAt]));
    if (times.length === 0) return null;
    return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  }

  /** R8 — the resume of an account, at its time or by hand. */
  private async resume(cliId: string, account: string, byHand: boolean): Promise<void> {
    const key = keyOf(cliId, account);
    const now = this.options.clock.now();
    await this.load();
    let waiting = this.options.agents.pausedAgents(cliId, account);
    if (waiting.length === 0) {
      this.paused.delete(key);
      return;
    }
    if (!byHand) {
      // Without the automatic resume the pause waits for « Reprendre ».
      const auto = await Promise.all(waiting.map((a) => this.options.autoResume(a.workspaceId)));
      waiting = waiting.filter((_, i) => auto[i]);
      if (waiting.length === 0) return;
      const until = this.waitFor(key, now);
      if (until !== null) {
        await this.replan(key, waiting, until, now);
        return;
      }
    }
    const info = this.paused.get(key);
    const resumeAt = info?.resumeAt ?? waiting[0]?.pause?.resumeAt ?? null;
    if (byHand) {
      const state = this.limit;
      await this.save({
        ...state,
        overrides: [
          ...state.overrides.filter(
            (o) => !(o.cliId === cliId && o.account === account && o.agentId === null),
          ),
          { cliId, account, until: resumeAt, agentId: null },
        ],
      });
    }
    const locks = await this.locksOf(waiting);
    const resumed = await this.resumeAll(waiting);
    const state = this.limit;
    await this.save({
      ...state,
      resumed: [
        ...state.resumed.filter((r) => r.cliId !== cliId || r.account !== account),
        { cliId, account, at: now.toISOString() },
      ],
    });
    this.paused.delete(key);
    await this.notify(resumed, locks, now);
  }

  /** US2 sc.2 — another window is still at its threshold: each agent waits for its reset. */
  private async replan(key: string, waiting: Agent[], until: string, now: Date) {
    for (const agent of waiting) {
      if (agent.scheduledResume?.at === until) continue;
      await this.options.agents.schedule(agent.id, nextResume(agent.id, new Date(until), 0, now));
    }
    const info = this.paused.get(key);
    if (info) this.paused.set(key, { ...info, resumeAt: until });
  }

  /** The orchestrators start first; the others follow. An agent that cannot resume is skipped. */
  private async resumeAll(agents: Agent[]): Promise<Agent[]> {
    const ordered = [...agents].sort(
      (a, b) => Number(b.role === 'orchestrator') - Number(a.role === 'orchestrator'),
    );
    const resumed: Agent[] = [];
    for (const agent of ordered) {
      try {
        if ((await this.options.agents.resumePaused(agent.id)) === 'resumed') resumed.push(agent);
      } catch {
        // Closed or its CLI gone meanwhile: the manual actions remain.
      }
    }
    return resumed;
  }

  private async locksOf(agents: Agent[]): Promise<Map<string, string>> {
    const locks = new Map<string, string>();
    for (const agent of agents) {
      const lock = await this.options.git.indexLock(agent.worktreePath).catch(() => null);
      if (lock !== null) locks.set(agent.id, agent.worktreePath);
    }
    return locks;
  }

  /** FR-008, FR-012 — the notice of each agent resumed; the orchestrators are told who came back. */
  private async notify(resumed: Agent[], locks: Map<string, string>, now: Date) {
    const ordered = [...resumed].sort(
      (a, b) => Number(a.role === 'orchestrator') - Number(b.role === 'orchestrator'),
    );
    for (const agent of ordered) {
      const pause = agent.pause;
      if (!pause) continue;
      const window = pause.windows.reduce((a, b) => (b.percent > a.percent ? b : a));
      const lead = agent.role === 'orchestrator';
      const mates = resumed.filter((a) => a.workspaceId === agent.workspaceId && a.id !== agent.id);
      const named = (a: Agent) => who(a, this.options.cliName(a.cliId));
      const text = resumedText({
        label: window.label,
        percent: window.percent,
        since: pause.pausedAt,
        until: now.toISOString(),
        who: lead ? 'orchestrator' : pause.midTurn ? 'busy' : 'idle',
        ...(lead && {
          resumed: mates.filter((a) => a.role !== 'orchestrator').map(named),
          unsaved: mates.filter((a) => a.pause?.saved === false).map(named),
        }),
        lockIn: locks.get(agent.id) ?? null,
      });
      const action = lead || pause.midTurn;
      try {
        await this.options.exchanges.record(agent.workspaceId, {
          from: 'pact',
          to: agent.id,
          kind: 'usage-resumed',
          type: action ? 'action' : 'info',
          text,
        });
        if (action) this.options.wake.deliver(agent.id);
      } catch {
        // The agent is gone (closed meanwhile): nothing to tell.
      }
    }
  }

  private pausedAgent(agentId: string): Agent | undefined {
    for (const info of this.paused.values()) {
      const found = this.options.agents
        .pausedAgents(info.cliId, info.account)
        .find((a) => a.id === agentId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * An agent changed state. An account whose last paused agent left the pause another way than its
   * resume (« Relancer », closed) is no longer in pause: it would hold its CLI until PACT restarts.
   */
  agentChanged(): void {
    for (const info of [...this.paused.values()]) this.forgetIfEmpty(info.cliId, info.account);
  }

  /** The last paused agent of the account resumed: the account is no longer in pause. */
  private forgetIfEmpty(cliId: string, account: string) {
    if (this.options.agents.pausedAgents(cliId, account).length === 0) {
      this.paused.delete(keyOf(cliId, account));
    }
  }

  /** The stop of one agent, then its notice, which it reads when it resumes. */
  private async stop(agent: Agent, info: PauseInfo) {
    try {
      await this.options.agents.pause(agent.id, info);
    } catch {
      // Closed or gone meanwhile: nothing to stop.
      return;
    }
    this.paused.set(keyOf(info.cliId, info.account), info);
    try {
      const auto = await this.options.autoResume(agent.workspaceId);
      await this.options.exchanges.record(agent.workspaceId, {
        from: 'pact',
        to: agent.id,
        kind: 'usage-paused',
        text: pausedText(info.windows, info.resumeAt, auto),
      });
    } catch {
      // The notice is a courtesy; the pause stands.
    }
  }
}
