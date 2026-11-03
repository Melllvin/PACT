import type { Role } from '../../shared/primitives';
import {
  DEFAULT_USAGE_THRESHOLDS,
  shownWindow,
  usageLevel,
  type UsageReading,
  type UsageState,
  type UsageThresholds,
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

type Account = { cliId: string; account: string; reading: UsageReading | null };

/** The account of a CLI: the folder its configuration is read from, or `default` (R3). */
export const accountOf = (folder: string | undefined) =>
  folder === undefined || folder === '' ? 'default' : folder;

export class UsageService {
  private readonly accounts = new Map<string, Account>();
  private readonly followers = new Map<string, Follower>();
  private readonly thresholds: () => UsageThresholds;
  private readonly onState: (state: UsageState) => void;
  private readonly now: () => Date;
  private readonly followRollout: FollowRollout;

  constructor({
    thresholds = () => DEFAULT_USAGE_THRESHOLDS,
    onState = () => undefined,
    now = () => new Date(),
    followRollout = (options) => new CodexRollout(options),
  }: {
    thresholds?: () => UsageThresholds;
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

  /** What a sample tells; a sample without limits keeps the last reading (FR-007). */
  record(source: UsageSource, sample: UsageSample): void {
    if (!sample.windows) return;
    const key = `${source.cliId}\u0000${source.account}`;
    const account: Account = {
      cliId: source.cliId,
      account: source.account,
      reading: {
        cliId: source.cliId,
        account: source.account,
        windows: sample.windows,
        readAt: this.now().toISOString(),
      },
    };
    this.accounts.set(key, account);
    this.onState(this.stateOf(account));
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
    this.release(source.agentId);
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

  release(agentId: string): void {
    this.followers.get(agentId)?.stop();
    this.followers.delete(agentId);
  }

  stop(): void {
    for (const id of [...this.followers.keys()]) this.release(id);
  }

  private stateOf({ cliId, account, reading }: Account): UsageState {
    const level = reading
      ? usageLevel(shownWindow(reading, this.now()).usedPercent, this.thresholds())
      : 'ok';
    return { cliId, account, reading, shares: [], level };
  }
}
