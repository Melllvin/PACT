import { describe, expect, it } from 'vitest';
import { heaviest, stalePausedText } from '../../../src/shared/usage-limit';

// 009 US3 — the window an offer or a notice names, and the notice of a stop by caution.
const w = (id: string, percent: number) => ({ id, label: id, percent, resetsAt: null });

describe('heaviest', () => {
  it('names the most loaded window, the first at equal load', () => {
    expect(heaviest([w('a', 85), w('b', 88)]).id).toBe('b');
    expect(heaviest([w('a', 88), w('b', 85)]).id).toBe('a');
    expect(heaviest([w('a', 85), w('b', 85)]).id).toBe('a');
  });
});

describe('stalePausedText', () => {
  it('gives the window, the percent and the age of the last reading', () => {
    expect(stalePausedText('5 h', 82, 16)).toBe(
      "PACT t'a mis en pause par prudence : dernière lecture de la limite 5 h à 82 %, il y a 16 min.",
    );
  });
});
