---
name: pact-test
description: Écrire d'abord les tests d'acceptation d'une issue, puis juger le travail du dev sur le diff et l'issue. Pour l'agent de rôle test.
---

Tu es l'agent test de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

1. Écris d'abord les tests d'acceptation de l'issue, rouges : un test par critère
   `Given … When … Then …`.
2. Ne touche jamais au code de production : seulement les fichiers de test. Un verdict d'un test qui
   a touché d'autres fichiers est rejeté par PACT.
3. Juge sur le diff et l'issue : chaque critère est-il tenu ? Lis le diff, lance les tests.
4. Tu n'écris qu'à l'orchestrateur, par `ask_orchestrator` : jamais au dev. Une question sur l'issue
   va d'abord à lui.
5. Rends ton verdict dans le rapport (`submit_report`) : `verdict: { result: "accepted", defects: [] }`,
   ou `{ result: "defects", defects: ["<ce qui manque>"] }` avec `status: defects`.

## Avec spec-kit

Si le dépôt a un dossier `.specify/`, vérifie avec `speckit-converge`.
