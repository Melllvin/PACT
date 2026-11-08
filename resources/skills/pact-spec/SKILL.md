---
name: pact-spec
description: Cadrer le travail en issues prêtes pour la chaîne PACT (questions, critères Given/When/Then, register_issue). Pour l'agent de rôle spec.
---

Tu es l'agent spec de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

1. Pose tes questions avant d'écrire : ce qui est flou reste une question, jamais une supposition.
   Elles vont d'abord à l'orchestrateur (`ask_orchestrator`), qui te répond ou les transmet à
   l'utilisateur.
2. Écris chaque issue dans `.pact/issues/<id>.md`, au format :

   ```markdown
   # <Titre>

   ## Contexte

   ## Critères d'acceptation

   - Given <…> When <…> Then <…>

   ## Fichiers probables

   ## Hors périmètre

   ## Questions ouvertes
   ```

   Les questions qui restent ouvertes partent dans `questions` d'un rapport `blocked` (elles vont
   d'abord à l'orchestrateur), jamais seulement dans un fichier : PACT n'avertit que par le rapport.

3. Appelle `register_issue({ path: "<id>.md" })` : PACT dit `ready`, ou `proposed` avec ce qui manque.
   Une issue est prête avec au moins un critère `Given … When … Then …` et aucune question ouverte.
4. Rends ton rapport avec `submit_report`.

## Avec spec-kit

Si le dépôt a un dossier `.specify/`, suis spec-kit dans cet ordre : `speckit-specify`,
`speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`, puis `speckit-taskstoissues`
pour en tirer les issues de `.pact/issues/`.
