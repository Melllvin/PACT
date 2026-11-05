import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// fix-todo-diff-notifications — two sentences the skills must carry, whatever their wording.

const read = async (path: string) =>
  (await readFile(join('resources/skills', path), 'utf8')).replace(/\s+/g, ' ');

describe('the skills of the suite', () => {
  it('pact-orchestrator: the orchestrator does not change the code, an agent does', async () => {
    const text = await read('pact-orchestrator/SKILL.md');
    expect(text).toMatch(/ne modifie (jamais|pas) le code du dépôt/i);
    expect(text).toMatch(/(confie|confier|délègue|déléguer)[^.]*(à un agent|à un autre agent)/i);
  });

  it('pact-spec: the questions left for the user go in a « blocked » report, never only in a file', async () => {
    const text = await read('pact-spec/SKILL.md');
    expect(text).toContain('`questions`');
    expect(text).toContain('`blocked`');
    expect(text).toMatch(/jamais (seulement|uniquement) (dans|en) (un|le) fichier/i);
  });
});
