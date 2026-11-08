import { describe, expect, it } from 'vitest';
import { applyTyped, EMPTY_DRAFT } from '../../../../src/main/agents/agent-state';

// 007 R5 — a bracketed paste leaves the content unknown; one never closed does too.

describe('applyTyped with a paste', () => {
  it('Given a paste that is never closed, Then the prompt is unknown', () => {
    const draft = applyTyped(EMPTY_DRAFT, '\x1b[200~du texte\nsur deux lignes', 'awaiting-prompt');
    expect(draft.unknown).toBe(true);
  });

  it('Given a closed paste followed by keys, Then the keys count and the content stays unknown', () => {
    const draft = applyTyped(EMPTY_DRAFT, '\x1b[200~collé\x1b[201~ab', 'awaiting-prompt');
    expect(draft).toMatchObject({ unknown: true, count: 2 });
  });

  it('Given a paste then Enter, Then the prompt is empty again', () => {
    const draft = applyTyped(EMPTY_DRAFT, '\x1b[200~collé\x1b[201~\r', 'awaiting-prompt');
    expect(draft).toEqual(EMPTY_DRAFT);
  });
});
