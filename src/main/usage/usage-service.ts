import type { Role } from '../../shared/primitives';
import {
  DEFAULT_USAGE_THRESHOLDS,
  launchWarning,
  shownWindow,
  usageLevel,
  type UsageReading,
  type UsageState,
  type UsageThresholds,
  type UsageWindow,
} from '../../shared/usage';
import { parseStatusline } from './claude-statusline';
import { CodexRollout } from './codex-rollout';
import type { UsageSample } from './sample';

// 005 R3 — the usage of each CLI account, from what its agents' CLIs report: the latest reading of
// an account replaces the previous one, whichever agent brought it.

/** Who brought a sample: the agent, and the account of its CLI. */
export type UsageSource = {
  agentId: string;
  workspaceId: string;
  label: string;
  role: Role | null;
  cliId: string;
  /** `default`, or the CLI's configuration folder (R3). */
  account: string;
};

type Follower = { start(): void; stop(): void };
type FollowRollout = (options: {
  codexHome: string;
  sessionId: string;
  onSample: (sample: UsageSample) => void;
}) => Follower;

/** What PACT counted for one agent in the current window (R5). */
type Share = { source: UsageSource; tokens: number; last: number; closed: boolean };

type Account = {
  cliId: string;
  account: string;
  reading: UsageReading | null;
  /** By agent, in the order they first reported. */
  shares: Map<string, Share>;
};

/** A later reset by more than this is a new window, not the drift of a CLI's clock. */
const RESET_DRIFT_MS = 10 * 60_000;

/** The reset of the shortest window of a reading: the one whose change starts the count again. */
function firstReset(windows: readonly UsageWindow[]): string | null {
  const [first] = [...windows].sort(
    (a, b) => (a.minutes ?? Number.POSITIVE_INFINITY) - (b.minutes ?? Number.POSITIVE_INFINITY),
  );
  return first?.resetsAt ?? null;
}

/** The account of a CLI: the folder its configuration is read from, or `default` (R3). */
export const accountOf = (folder: string | undefined) =>
  folder === undefined || folder === '' ? 'default' : folder;

export class UsageService {
  private readonly accounts = new Map<string, Account>();
  private readonly followers = new Map<string, Follower>();
  private thresholds: UsageThresholds;
  private readonly onState: (state: UsageState) => void;
  private readonly now: () => Date;
  private readonly followRollout: FollowRollout;

  constructor({
    thresholds = DEFAULT_USAGE_THRESHOLDS,
    onState = () => undefined,
    now = () => new Date(),
    followRollout = (options) => new CodexRollout(options),
  }: {
    thresholds?: UsageThresholds;
    onState?: (state: UsageState) => void;
    now?: () => Date;
    followRollout?: FollowRollout;
  } = {}) {
    this.thresholds = thresholds;
    this.onState = onState;
    this.now = now;
    this.followRollout = followRollout;
  }

  /** The current state of every account read so far (`usage:get`). */
  list(): UsageState[] {
    return [...this.accounts.values()].map((account) => this.stateOf(account));
  }

  /** 005 FR-010 — new thresholds: every account is told again with its level. */
  setThresholds(thresholds: UsageThresholds): void {
    this.thresholds = thresholds;
    for (const account of this.accounts.values()) this.onState(this.stateOf(account));
  }

  /** 005 FR-012 — the warning of a launch of agents of `cliId`, or null. */
  warning(cliId: string): string | null {
    return launchWarning(this.list(), cliId, this.thresholds, this.now());
  }

  /**
   * 005 FR-015, R8 — when the account can work again: the reset of its window at the limit, else
   * of its highest; undefined without a reading or without its time.
   */
  resetAt(cliId: string, account: string): Date | undefined {
    const windows = this.accounts.get(`${cliId}\u0000${account}`)?.reading?.windows ?? [];
    const [window] = [...windows].sort(
      (a, b) =>
        Number(b.usedPercent >= 100) - Number(a.usedPercent >= 100) ||
        b.usedPercent - a.usedPercent,
    );
    return window?.resetsAt ? new Date(window.resetsAt) : undefined;
  }

  /**
   * What a sample tells; a sample without limits keeps the last reading (FR-007) and only counts
   * the agent's tokens, without an event.
   */
  record(source: UsageSource, sample: UsageSample): void {
    const key = `${source.cliId}\u0000${source.account}`;
    const known = this.accounts.get(key);
    if (!sample.windows) {
      if (known) this.count(known, source, sample.tokens);
      return;
    }
    const now = this.now();
    const account: Account = {
      cliId: source.cliId,
      account: source.account,
      reading: {
        cliId: source.cliId,
        account: source.account,
        windows: sample.windows,
        readAt: now.toISOString(),
      },
      shares:
        known?.reading && !this.isNewWindow(known.reading, sample.windows, now)
          ? known.shares
          : new Map<string, Share>(),
    };
    this.count(account, source, sample.tokens);
    this.accounts.set(key, account);
    this.onState(this.stateOf(account));
  }

  /** R5 — the window reset since the last reading: every part starts again (FR-014). */
  private isNewWindow(previous: UsageReading, windows: UsageWindow[], now: Date): boolean {
    const before = firstReset(previous.windows);
    const after = firstReset(windows);
    if (before === null) return false;
    if (Date.parse(before) <= now.getTime()) return true;
    return after !== null && Date.parse(after) - Date.parse(before) > RESET_DRIFT_MS;
  }

  /** R5 — the agent's tokens since its first reading of the window; a new session goes on. */
  private count(account: Account, source: UsageSource, tokens: number): void {
    const share = account.shares.get(source.agentId);
    if (!share) {
      account.shares.set(source.agentId, { source, tokens: 0, last: tokens, closed: false });
      return;
    }
    share.tokens += tokens >= share.last ? tokens - share.last : tokens;
    share.last = tokens;
    share.source = source;
    share.closed = false;
  }

  /**
   * 005 R1 — a statusLine payload of Claude Code, posted by the bridge: recorded, and answered
   * with the line the agent's terminal shows. Never throws.
   */
  statusLine(source: UsageSource, payload: unknown): string {
    const sample = parseStatusline(payload);
    if (sample) this.record(source, sample);
    const reading = this.accounts.get(`${source.cliId}\u0000${source.account}`)?.reading;
    if (!reading) return 'PACT';
    const shown = shownWindow(reading, this.now());
    return `PACT · ${shown.label} ${String(Math.round(shown.usedPercent))} %`;
  }

  /** 005 R2 — follows the rollout of a Codex session until the agent stops. */
  follow(source: UsageSource, { codexHome, sessionId }: { codexHome: string; sessionId: string }) {
    this.unfollow(source.agentId);
    const follower = this.followRollout({
      codexHome,
      sessionId,
      onSample: (sample) => {
        this.record(source, sample);
      },
    });
    this.followers.set(source.agentId, follower);
    follower.start();
  }

  /** The agent stopped: its part stays, marked closed, until the window resets (FR-014). */
  release(agentId: string): void {
    this.unfollow(agentId);
    for (const account of this.accounts.values()) {
      const share = account.shares.get(agentId);
      if (!share || share.closed) continue;
      share.closed = true;
      this.onState(this.stateOf(account));
    }
  }

  stop(): void {
    for (const id of [...this.followers.keys()]) this.unfollow(id);
  }

  private unfollow(agentId: string): void {
    this.followers.get(agentId)?.stop();
    this.followers.delete(agentId);
  }

  private stateOf({ cliId, account, reading, shares }: Account): UsageState {
    const level = reading
      ? usageLevel(shownWindow(reading, this.now()).usedPercent, this.thresholds)
      : 'ok';
    return {
      cliId,
      account,
      reading,
      shares: [...shares.entries()]
        .map(([agentId, { source, tokens, closed }]) => ({
          agentId,
          workspaceId: source.workspaceId,
          label: source.label,
          role: source.role,
          tokens,
          closed,
        }))
        .sort((a, b) => b.tokens - a.tokens),
      level,
    };
  }
}
