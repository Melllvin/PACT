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
    'plafond du projet',
    'PACT relance lui-même la commande de test',
    'Definition of Ready',
    'Given … When … Then …',
    'aucune question ouverte',
    'Definition of Done',
    'sortent à 0',
    'Le rapport est rendu',
    'Le recap (`.pact/recap.md`) est à jour',
  ],
  'pact-orchestrator/SKILL.md': [
    'list_agents',
    'send_prompt',
    'wait_for_agents',
    'request_delivery',
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
    'plafond du projet',
    'polish_pass',
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

// 007 T057 — questions of the agents go to the orchestrator first, permissions stay with the user
// (FR-032), `wait_for_agents` is a fallback (US5 sc.4), nobody reads what a third party wrote
// (FR-027, US3 sc.10).
describe('skills about the exchanges between agents (007)', () => {
  const sentences = (text: string) => flat(text).split(/(?<=[.!?:])\s+/);
  const has = (text: string, ...parts: RegExp[]) =>
    sentences(text).some((sentence) => parts.every((part) => part.test(sentence)));

  const ALL = [
    'pact-contract.md',
    'pact-orchestrator/SKILL.md',
    'pact-spec/SKILL.md',
    'pact-design-system/SKILL.md',
    'pact-mockup/SKILL.md',
    'pact-dev/SKILL.md',
    'pact-test/SKILL.md',
    'pact-recap/SKILL.md',
  ];

  it.each(ALL)('%s no longer sends the questions of the agents to the user', async (path) => {
    expect(flat(await read(path))).not.toContain(
      "Les questions et autorisations des agents sont à l'utilisateur",
    );
  });

  it("pact-contract.md no longer says « Les questions sont à l'utilisateur »", async () => {
    expect(flat(await read('pact-contract.md'))).not.toContain(
      "Les questions sont à l'utilisateur",
    );
  });

  it.each(['pact-contract.md', 'pact-orchestrator/SKILL.md'])(
    '%s sends the questions to the orchestrator first and the permissions to the user',
    async (path) => {
      const text = await read(path);
      expect(has(text, /question/i, /d'abord/i, /orchestrateur/i), 'questions').toBe(true);
      expect(has(text, /autorisation/i, /utilisateur/i), 'autorisations').toBe(true);
    },
  );

  it.each(['pact-contract.md', 'pact-orchestrator/SKILL.md'])(
    '%s names get_events and ask_orchestrator',
    async (path) => {
      const text = flat(await read(path));
      expect(text).toContain('get_events');
      expect(text).toContain('ask_orchestrator');
    },
  );

  it.each(['pact-contract.md', 'pact-orchestrator/SKILL.md'])(
    '%s forbids reading what a third party wrote',
    async (path) => {
      expect(
        has(
          await read(path),
          /tiers/i,
          /\b(lire|lis|lit|récupér\w*)\b/i,
          /jamais|interdit|\bne\b/i,
        ),
      ).toBe(true);
    },
  );

  it('pact-orchestrator says to end the turn and be woken, with wait_for_agents as a fallback only', async () => {
    const text = await read('pact-orchestrator/SKILL.md');
    expect(flat(text)).toMatch(/finir son tour|finis ton tour/i);
    expect(has(text, /wait_for_agents/, /secours/i), 'wait_for_agents en secours').toBe(true);
    expect(flat(text)).not.toContain('`wait_for_agents` : attends la fin de leur tour');
  });

  it('pact-test writes only through ask_orchestrator, never to the dev', async () => {
    const text = await read('pact-test/SKILL.md');
    expect(flat(text)).toContain('ask_orchestrator');
    expect(has(text, /\bdev\b/i, /jamais/i), 'jamais au dev').toBe(true);
  });

  it.each(['pact-spec/SKILL.md', 'pact-dev/SKILL.md'])(
    '%s cites the new route of the questions',
    async (path) => {
      const text = await read(path);
      expect(flat(text)).toContain('ask_orchestrator');
      expect(has(text, /question/i, /orchestrateur/i)).toBe(true);
    },
  );
});

// 008 T057 / US5 sc.7 — the contract no longer fixes the number of rounds: it says the ceiling is the
// PROJECT’s (`workspace.delivery.maxRounds`, 1 to 10, 3 by default).
//
// RED until T061. The existing `MUST_SAY` above still lists « 3 tours » for `pact-contract.md` and
// « Jamais de 4ᵉ tour » for the orchestrator’s skill: both are replaced by the spec and are for the dev to change
// (T061); they are left as they are here.
describe('the contract says the ceiling of the project, not « 3 tours » (008 US5 sc.7)', () => {
  it('Given pact-contract.md, When it is read, Then it no longer says « 3 tours » or « 3ᵉ verdict »', async () => {
    const contract = flat(await read('pact-contract.md'));

    expect(contract).not.toContain('3 tours');
    expect(contract).not.toMatch(/\b3\s*(?:ᵉ|e|è)?\s*(?:verdict|tour)\b/);
    expect(contract).not.toContain('4ᵉ tour');
  });

  it('Given pact-contract.md, When it is read, Then it says the ceiling of the project and that after it the user decides', async () => {
    const contract = flat(await read('pact-contract.md'));

    expect(contract).toContain('plafond du projet');
    expect(contract).toMatch(/l['’]utilisateur décide/);
  });

  it('Given the skills of the suite, When they are read, Then none tells an agent that a loop is three rounds', async () => {
    for (const path of [
      'pact-contract.md',
      'pact-orchestrator/SKILL.md',
      'pact-dev/SKILL.md',
      'pact-test/SKILL.md',
    ]) {
      const text = flat(await read(path));
      expect(text, path).not.toContain('3 tours');
      expect(text, path).not.toContain('4ᵉ tour');
    }
  });
});
