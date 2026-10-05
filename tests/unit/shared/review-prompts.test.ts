import { describe, expect, it } from 'vitest';
import { reviewPrompt } from '../../../src/shared/review-prompts';

// 002 T036 — the instructions the review types into the agent's prompt (research R7, FR-012,
// FR-013, FR-015).

describe('reviewPrompt', () => {
  it('quotes the file, the line and the comment (US3/AC1)', () => {
    expect(
      reviewPrompt({
        kind: 'comment',
        path: 'src/auth/otp.ts',
        line: 3,
        text: 'Le TTL devrait venir de la config.',
      }),
    ).toBe('Commentaire sur src/auth/otp.ts:3 — Le TTL devrait venir de la config.');
  });

  it('lists every comment to fix in one instruction (US3/AC2)', () => {
    const text = reviewPrompt({
      kind: 'fix-comments',
      comments: [
        { path: 'a.ts', line: 3, text: 'Renommer.' },
        { path: 'src/b.ts', line: 12, text: 'Sur deux\nlignes.' },
      ],
    });
    expect(text).toBe(
      [
        'Corrige les commentaires de la revue :',
        '- a.ts:3 — Renommer.',
        '- src/b.ts:12 — Sur deux\nlignes.',
      ].join('\n'),
    );
  });

  it('gives the test command and the last 40 lines of its output (US3/AC3)', () => {
    const output = Array.from({ length: 50 }, (_, i) => `ligne ${String(i + 1)}`).join('\n');
    const text = reviewPrompt({
      kind: 'failing-tests',
      command: 'npm test',
      output: `${output}\n`,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Les tests échouent (`npm test`). Corrige-les. Fin de la sortie :');
    expect(lines.slice(1)).toEqual(Array.from({ length: 40 }, (_, i) => `ligne ${String(i + 11)}`));
  });

  it('says only that the tests fail when they wrote nothing', () => {
    expect(reviewPrompt({ kind: 'failing-tests', command: 'make check', output: '  \n' })).toBe(
      'Les tests échouent (`make check`). Corrige-les.',
    );
  });

  it('names the conflicting files and asks to update, resolve and test again (US3/AC3)', () => {
    expect(
      reviewPrompt({ kind: 'conflict', mainBranch: 'main', files: ['a.txt', 'src/b.ts'] }),
    ).toBe(
      'Conflit avec main sur a.txt, src/b.ts. Mets ta branche à jour depuis main, ' +
        'résous les conflits, puis relance les tests.',
    );
  });

  it('sends a request as written (FR-015)', () => {
    expect(reviewPrompt({ kind: 'request', text: 'Ajoute un test.\nMerci.' })).toBe(
      'Ajoute un test.\nMerci.',
    );
  });
});
