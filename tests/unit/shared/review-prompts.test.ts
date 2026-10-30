import { describe, expect, it } from 'vitest';
import {
  FAILING_TAIL_LINES,
  commentPrompt,
  conflictPrompt,
  failingTestsPrompt,
  fixCommentsPrompt,
  requestPrompt,
} from '../../../src/shared/review-prompts';

// 002 T036 — the instructions the review types into the agent's CLI (research R7).

describe('commentPrompt', () => {
  it('cites the file, the line and the comment', () => {
    expect(
      commentPrompt({ path: 'src/auth/otp.ts', line: 3, text: 'Le TTL devrait venir de la config.' }),
    ).toBe('Commentaire sur src/auth/otp.ts:3 — Le TTL devrait venir de la config.');
  });

  it('keeps a multi-line comment whole, trimmed', () => {
    expect(commentPrompt({ path: 'a.ts', line: 1, text: '  un\ndeux  ' })).toBe(
      'Commentaire sur a.ts:1 — un\ndeux',
    );
  });
});

describe('fixCommentsPrompt', () => {
  it('lists every comment given, one per line, in order', () => {
    expect(
      fixCommentsPrompt([
        { path: 'src/a.ts', line: 3, text: 'Renommer.' },
        { path: 'src/b.ts', line: 12, text: 'Ajouter un test.' },
      ]),
    ).toBe(
      [
        'Corrige les commentaires de revue suivants :',
        '- src/a.ts:3 — Renommer.',
        '- src/b.ts:12 — Ajouter un test.',
      ].join('\n'),
    );
  });

  it('indents the following lines of a multi-line comment under its item', () => {
    expect(fixCommentsPrompt([{ path: 'a.ts', line: 1, text: 'un\ndeux' }])).toBe(
      'Corrige les commentaires de revue suivants :\n- a.ts:1 — un\n  deux',
    );
  });
});

describe('failingTestsPrompt', () => {
  it('gives the command and the last lines of the output', () => {
    const output = Array.from({ length: 100 }, (_, i) => `ligne ${String(i + 1)}`).join('\n');
    const prompt = failingTestsPrompt('npm test', `${output}\n`);
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('Les tests échouent (`npm test`). Corrige-les, puis relance-les.');
    expect(lines[1]).toBe(`Dernières lignes de la sortie :`);
    expect(lines.slice(2)).toHaveLength(FAILING_TAIL_LINES);
    expect(FAILING_TAIL_LINES).toBe(40);
    expect(lines.at(2)).toBe('ligne 61');
    expect(lines.at(-1)).toBe('ligne 100');
  });

  it('says nothing about the output when there is none', () => {
    expect(failingTestsPrompt('npm test', '  \n')).toBe(
      'Les tests échouent (`npm test`). Corrige-les, puis relance-les.',
    );
  });
});

describe('conflictPrompt', () => {
  it('names the files and asks to update from main, resolve and run the tests again', () => {
    expect(conflictPrompt('main', ['pages/login.tsx', 'api/routes.ts'])).toBe(
      [
        'Ta branche est en conflit avec main sur : pages/login.tsx, api/routes.ts.',
        'Mets ta branche à jour depuis main dans ton worktree (rebase ou merge), résous les conflits, puis relance les tests.',
      ].join('\n'),
    );
  });
});

describe('requestPrompt', () => {
  it('sends the request as it was written, trimmed', () => {
    expect(requestPrompt('  Ajoute un test pour le cas vide.\n')).toBe(
      'Ajoute un test pour le cas vide.',
    );
  });
});
