# Contract: rapport de relais (`submit_report`)

Schéma zod partagé : `src/shared/report.ts`. Le contrat commun des skills (`pact-contract.md`) le
reproduit pour les agents.

| Champ | Type | Règle |
|-------|------|------|
| `issue` | string | identifiant d'une issue du workspace |
| `status` | `'done' \| 'blocked' \| 'defects'` | `defects` réservé au rôle `test` |
| `summary` | string, 1 à 2 000 caractères | |
| `files` | string[] | chemins relatifs au dépôt (`repoPathSchema`) |
| `checks` | `{ command: string; exitCode: number }[]` | au moins une entrée pour `done` |
| `questions` | string[] | défaut `[]` ; non vide ⇒ `status: 'blocked'` |
| `verdict` | `{ result: 'accepted' \| 'defects'; defects: string[] }` | obligatoire pour le rôle `test`, interdit sinon ; `defects` non vide si `result: 'defects'` |

Ajoutés par PACT : `agentId`, `role`, `round`, `at`.

Effets : le rapport rejoint le tour courant de la boucle de l'issue ; un verdict `defects` permet
`next_round` ; un verdict `accepted` lance la preuve (R6) ; un verdict d'un test qui a touché des
fichiers hors `testPaths` est rejeté (événement `loop` avec `state: 'running'` et la raison, FR-020).
