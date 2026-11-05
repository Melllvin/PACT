import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 004 T041 — each skill of the suite says what contracts/skills.md asks of it (« Doit dire »).

const DIR = 'resources/skills';

const read = (path: string) => readFile(join(DIR, path), 'utf8');

/** The text with its line breaks and indentation as single spaces: wrapping says nothing. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** What each skill must say, as it is written in it. */
const MUST_SAY: Record<string, string[]> = {
  'pact-contract.md': [
    'submit_report',
    '`issue`',
    '`status`',
    '`summary`',
    '`files`',
    '`checks`',
    '`questions`',
    '`verdict`',
    '3 tours',
    'PACT relance lui-même la commande de test',
    'Definition of Ready',
    'Given … When … Then …',
    'aucune question ouverte',
    'Definition of Done',
    'sortent à 0',
    'Le rapport est rendu',
    'Le recap (`.pact/recap.md`) est à jour',
    "Les questions sont à l'utilisateur",
  ],
  'pact-orchestrator/SKILL.md': [
    'list_agents',
    'send_prompt',
    'wait_for_agents',
    'request_integration',
    'Cadrage',
    'Design',
    'Boucle',
    'Recap',
    'pact-spec',
    'pact-design-system',
    'pact-mockup',
    'pact-dev',
    'pact-test',
    'pact-recap',
    'launch_agent({ role: "dev" })',
    'Jamais de 4ᵉ tour',
    '.specify/',
  ],
  'pact-spec/SKILL.md': [
    'Pose tes questions',
    '.pact/issues/<id>.md',
    "## Critères d'acceptation",
    '## Questions ouvertes',
    'register_issue',
    '.specify/',
    'speckit-specify`,\n`speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`, puis `speckit-taskstoissues`',
  ],
  'pact-design-system/SKILL.md': [
    'W3C Design Tokens',
    'DESIGN.md',
    'couleurs, typographie, espacements,\n   composants',
    'design/tokens.json',
    'design/tokens.css',
    'design/DESIGN.md',
    'design/mockups/00-design-system.html',
  ],
  'pact-mockup/SKILL.md': [
    'HTML statique sous `design/mockups/`',
    '../tokens.css',
    'valeurs de jetons',
    'Aucune ressource externe',
  ],
  'pact-dev/SKILL.md': [
    'Ne commence que sur une issue prête',
    "tests d'acceptation",
    'commande de test',
    '`status: done` et `checks`',
    '.specify/',
    'speckit-implement',
  ],
  'pact-test/SKILL.md': [
    "Écris d'abord les tests d'acceptation",
    'rouges',
    'Ne touche jamais au code de production',
    "Juge sur le diff et l'issue",
    'verdict',
    '.specify/',
    'speckit-converge',
  ],
  'pact-recap/SKILL.md': [
    '.pact/recap.md',
    'list_issues',
    'get_loop',
    '# Recap — <date>',
    '### À tester à la main',
    'Rien à tester à la main',
  ],
};

describe('the skills of the roles', () => {
  for (const [path, rules] of Object.entries(MUST_SAY)) {
    it(`${path} says what its role needs`, async () => {
      const text = flat(await read(path));
      expect(rules.filter((rule) => !text.includes(flat(rule)))).toEqual([]);
    });
  }

  it('gives each skill the front matter of Agent Skills, named after its folder', async () => {
    for (const path of Object.keys(MUST_SAY).filter((p) => p.endsWith('/SKILL.md'))) {
      const name = path.split('/')[0] ?? '';
      const text = await read(path);
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
      expect(front?.[1], path).toBe(name);
      expect(front?.[2]?.length, path).toBeGreaterThan(20);
    }
  });

  it('sends every skill to the common contract', async () => {
    for (const path of Object.keys(MUST_SAY).filter((p) => p.endsWith('/SKILL.md'))) {
      expect(flat(await read(path)), path).toContain(
        '`pact-contract.md`, dans le dossier de ce skill',
      );
    }
  });
});

// fix-relance-communs — no more ban on touching the files another agent touches: each agent works
// in its worktree, pushes its branch, and can fetch another branch when it needs it.
describe('skills about the files two agents change', () => {
  const FORBIDDEN = [
    /Pas de fichiers communs en parallèle/i,
    /ne modifient jamais les mêmes fichiers/i,
    /ne doivent pas modifier les mêmes fichiers/i,
    /mêmes fichiers en même temps/i,
  ];

  it.each(['pact-contract.md', 'pact-orchestrator/SKILL.md'])(
    '%s no longer forbids the same files as another agent',
    async (path) => {
      const text = flat(await read(path));
      for (const banned of FORBIDDEN) expect(text).not.toMatch(banned);
    },
  );

  it.each(['pact-contract.md', 'pact-orchestrator/SKILL.md'])(
    '%s says each agent works in its worktree, pushes its branch and can fetch another',
    async (path) => {
      const text = flat(await read(path));
      expect(text).toMatch(/worktree/i);
      expect(text).toMatch(/pouss\w*\b[^.]*\bbranche/i);
      expect(text).toMatch(/récupér\w*\b[^.]*\bautre branche/i);
    },
  );
});
