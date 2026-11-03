import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scenarioPath } from '../../../fixtures/fake-cli/paths';

// 004 T037 — the recap the pact-recap skill keeps follows contracts/files.md (FR-029): per issue,
// its state, agents with role and model, branch, PR, loop turns, the PACT tests and « À tester à la
// main ».

const ROLES = 'orchestrateur|spec|design|dev|test|recap';

/** What is wrong with `text` as a `.pact/recap.md`; empty when it follows the contract. */
function recapProblems(text: string): string[] {
  const problems: string[] = [];
  const [head = '', ...issues] = text.split(/^## /m);
  if (!/^# Recap — \S/.test(head)) problems.push('titre « # Recap — <date> » absent');
  if (issues.length === 0) problems.push('aucune issue');
  for (const issue of issues) {
    const [title = '', ...lines] = issue.trimEnd().split('\n');
    const name = title.trim();
    if (!/^\S+ · .+ — \S/.test(name)) problems.push(`en-tête « ${name} » hors format`);
    const has = (pattern: RegExp) => lines.some((line) => pattern.test(line));
    if (!has(new RegExp(`^- Agents : .+ \\((${ROLES}), [^)]+\\)`))) {
      problems.push(`${name} : agents (rôle, modèle) absents`);
    }
    if (!has(/^- Branche : \S+ · PR : (https:\/\/\S+|aucune)$/)) {
      problems.push(`${name} : branche ou PR absente`);
    }
    if (!has(/^- Tours : [0-3]\/3 · Tests PACT : .+ → -?\d+$/)) {
      problems.push(`${name} : tours ou tests PACT absents`);
    }
    const manual = lines.indexOf('### À tester à la main');
    if (manual === -1 || !lines.slice(manual + 1).some((line) => line.startsWith('- '))) {
      problems.push(`${name} : « À tester à la main » vide ou absent`);
    }
  }
  return problems;
}

describe('the recap format', () => {
  it('is followed by the example of the pact-recap skill', async () => {
    const example = await readFile('resources/skills/pact-recap/recap.md', 'utf8');
    expect(recapProblems(example)).toEqual([]);
    expect(example).toContain('- Rien à tester à la main');
  });

  it('is followed by the recap of the end-to-end tests', async () => {
    const scenario = JSON.parse(await readFile(scenarioPath('recap-writer'), 'utf8')) as {
      files: { write: string; content: string }[];
    };
    const recap = scenario.files.find((step) => step.write === '.pact/recap.md');
    expect(recapProblems(recap?.content ?? '')).toEqual([]);
  });

  it('tells what is missing', () => {
    expect(recapProblems('# Recap — 3 novembre\n\n## 0012 · Connexion — terminée\n')).toEqual([
      '0012 · Connexion — terminée : agents (rôle, modèle) absents',
      '0012 · Connexion — terminée : branche ou PR absente',
      '0012 · Connexion — terminée : tours ou tests PACT absents',
      '0012 · Connexion — terminée : « À tester à la main » vide ou absent',
    ]);
    expect(recapProblems('Notes\n')).toEqual(['titre « # Recap — <date> » absent', 'aucune issue']);
    expect(recapProblems('# Recap — 3 novembre\n\n## Connexion\n- Rien\n')[0]).toBe(
      'en-tête « Connexion » hors format',
    );
  });
});
