# Contrat PACT — commun à tous les rôles

Tu travailles dans un workspace PACT : chaque agent a son CLI, son worktree, sa branche et un rôle
(orchestrateur, spec, design, dev, test, recap). Ce contrat vaut pour tous ; ton skill de rôle dit
le reste.

## Rapport de relais (`submit_report`)

À la fin de chaque travail confié, appelle l'outil `submit_report` du serveur MCP « pact » :

| Champ       | Règle                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `issue`     | identifiant de l'issue (nom du fichier de `.pact/issues/` sans `.md`)    |
| `status`    | `done`, `blocked`, ou `defects` (rôle test seulement)                    |
| `summary`   | ce que tu as fait, 1 à 2 000 caractères                                  |
| `files`     | chemins relatifs au dépôt des fichiers touchés                           |
| `checks`    | `{ command, exitCode }` des commandes lancées ; au moins une pour `done` |
| `questions` | tes questions ; non vide ⇒ `status: blocked`                             |
| `verdict`   | rôle test seulement : `{ result: accepted \| defects, defects: [...] }`  |

Un tour sans rapport est signalé à l'orchestrateur : rends toujours ton rapport, même bloqué.

## Boucle dev ↔ test

- Une issue se règle en 3 tours au plus : le test écrit les tests d'acceptation, le dev les fait
  passer, le test rend son verdict. Après le 3ᵉ verdict `defects`, l'utilisateur décide : jamais de
  4ᵉ tour.
- La preuve est celle de PACT : PACT relance lui-même la commande de test ; un « ça passe chez moi »
  ne compte pas.

## Definition of Ready

Une issue est prête quand elle a au moins un critère d'acceptation au format
`Given … When … Then …` et aucune question ouverte. Aucun dev ne commence une issue qui n'est pas
prête.

## Definition of Done

- Les tests PACT sortent à 0 (code de sortie de la commande de test).
- Le rapport est rendu avec `submit_report`.
- Le recap (`.pact/recap.md`) est à jour.

## Règles communes

- Chaque agent travaille dans son worktree, sur sa branche, et pousse sa branche sur git. Si tu as
  besoin du travail d'un autre agent, tu peux récupérer son autre branche (`git fetch`, puis merge
  ou cherry-pick) au lieu de réécrire ses fichiers.
- Les questions sont à l'utilisateur : quand tu as un doute, écris-le dans `questions` avec
  `status: blocked` au lieu de deviner. Les demandes d'autorisation passent par l'utilisateur, jamais
  par un autre agent.
- Ne modifie jamais la configuration de ton CLI ni de l'utilisateur.
