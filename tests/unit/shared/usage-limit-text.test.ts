import { describe, expect, it } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent, Workspace } from '../../../src/shared/model';
import { clockTime, launchWarning, pauseWarning } from '../../../src/shared/usage';
import { pausedText, pausesOf, resumedText, saveText } from '../../../src/shared/usage-limit';
import { agent } from '../renderer/tiles/fixtures';

// 009 — the texts of contracts/events.md and the pause items, in the cases the main tests do not reach.

const RESET = '2030-01-01T11:00:00.000Z';
const pause = (over: Record<string, unknown> = {}) => ({
  cliId: 'claude-code',
  account: 'default',
  cause: 'threshold' as const,
  windows: [{ id: 'five-hour', label: '5 h', percent: 91, resetsAt: RESET as string | null }],
  resumeAt: RESET as string | null,
  pausedAt: '2030-01-01T09:00:00.000Z',
  midTurn: false,
  saved: true,
  closedQuestion: null,
  blocked: null,
  ...over,
});
const thresholds = { warn: 80, critical: 95 };
const NOW = new Date('2030-01-01T09:05:00.000Z');

describe('pausedText', () => {
  it('names one window, then several, in the words of the contract', () => {
    expect(pausedText([{ label: '5 h', percent: 90 }], RESET, true)).toBe(
      `PACT t'a mis en pause : limite 5 h à 90 %. Reprise prévue à ${clockTime(RESET)}.`,
    );
    expect(
      pausedText(
        [
          { label: '5 h', percent: 91 },
          { label: 'semaine', percent: 90 },
          { label: 'semaine · Opus', percent: 92 },
        ],
        null,
        true,
      ),
    ).toBe(
      "PACT t'a mis en pause : limites 5 h à 91 %, semaine à 90 % et semaine · Opus à 92 %. Reprise après la réinitialisation, heure inconnue.",
    );
  });

  it('says the user resumes by hand when the automatic resume is off', () => {
    expect(pausedText([{ label: '5 h', percent: 90 }], RESET, false)).toBe(
      "PACT t'a mis en pause : limite 5 h à 90 %. Reprise à la main par l'utilisateur.",
    );
  });
});

describe('saveText', () => {
  it('asks for a commit in the minute after a jump', () => {
    expect(saveText('5 h', 92, 90, true)).toContain('en local, dans la minute : git add');
    expect(saveText('5 h', 87, 90, false)).toContain('en local : git add');
  });
});

describe('pauseWarning and launchWarning during a pause', () => {
  it('says « sa réinitialisation » when the time is unknown, and joins the windows', () => {
    const text = pauseWarning(
      pause({
        resumeAt: null,
        windows: [
          { id: 'a', label: '5 h', percent: 90, resetsAt: null },
          { id: 'b', label: 'semaine', percent: 90, resetsAt: null },
        ],
      }),
    );
    expect(text).toBe(
      "PACT est en pause sur la limite 5 h et semaine jusqu'à sa réinitialisation : ces agents ne seront pas arrêtés avant la réinitialisation.",
    );
  });

  it('is the pause alone when no gauge is near its limit', () => {
    expect(launchWarning([], 'claude-code', thresholds, NOW, [pause()])).toBe(
      pauseWarning(pause()),
    );
  });
});

describe('pausesOf', () => {
  it('collects the pause of every paused agent of every workspace, and only those', () => {
    const paused = agent(1, { state: 'paused', pause: pause() });
    expect(
      pausesOf([{ agents: [paused, agent(2)] }, { agents: [agent(3)] }, { agents: [] }]),
    ).toEqual([pause()]);
  });
});

describe('deriveTodos — usage-paused titles', () => {
  const ws = (agents: Agent[]): Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch'> => ({
    agents,
    freeTerminals: [],
    mainBranch: 'main',
  });
  const names = () => 'Claude Code';

  it('names every window in the title and says the reset is unknown', () => {
    const [item] = deriveTodos(
      ws([
        agent(1, {
          state: 'paused',
          pause: pause({
            resumeAt: null,
            windows: [
              { id: 'a', label: '5 h', percent: 91, resetsAt: null },
              { id: 'b', label: 'semaine', percent: 90, resetsAt: null },
            ],
          }),
        }),
      ]),
      names,
    );
    expect(item?.title).toBe(
      '◆ En pause · Claude Code · limites 5 h à 91 % et semaine à 90 % · reprise après réinitialisation',
    );
  });
});

describe('pausedText with no window', () => {
  it('still reads as a sentence', () => {
    expect(pausedText([], null, false)).toBe(
      "PACT t'a mis en pause : limite . Reprise à la main par l'utilisateur.",
    );
  });
});

describe('resumedText (contracts/events.md « usage-resumed »)', () => {
  const head = `Reprise après la limite 5 h (90 %), en pause de ${clockTime('2030-01-01T09:00:00.000Z')} à ${clockTime(RESET)}.`;
  const base = {
    label: '5 h',
    percent: 90,
    since: '2030-01-01T09:00:00.000Z',
    until: RESET,
  };

  it('gives an idle agent the first sentence only, a busy one the continue sentence', () => {
    expect(resumedText({ ...base, who: 'idle' })).toBe(head);
    expect(resumedText({ ...base, who: 'busy' })).toBe(
      `${head} Reprends ton travail là où tu t'es arrêté.`,
    );
  });

  it('lists the agents resumed and those not saved to an orchestrator, and says no turn was counted', () => {
    expect(
      resumedText({
        ...base,
        who: 'orchestrator',
        resumed: ['Claude 2 · dev', 'Claude 3 · test'],
        unsaved: ['Claude 2 · dev'],
      }),
    ).toBe(
      `${head} Agents repris : Claude 2 · dev, Claude 3 · test. La pause n'a compté aucun tour ni rapport manquant. Non sauvegardé à l'arrêt : Claude 2 · dev.`,
    );
    expect(resumedText({ ...base, who: 'orchestrator' })).toBe(
      `${head} La pause n'a compté aucun tour ni rapport manquant.`,
    );
  });

  it('names the Git lock found, and only when there is one', () => {
    expect(resumedText({ ...base, who: 'idle', lockIn: '/wt/2' })).toBe(
      `${head} Verrou Git trouvé dans /wt/2 : vérifie-le avant de committer, PACT ne l'a pas effacé.`,
    );
    expect(resumedText({ ...base, who: 'idle', lockIn: null })).toBe(head);
  });
});
