---
name: pact-orchestrator
description: Diriger la chaîne de livraison PACT de ce workspace (cadrage, design, boucle dev ↔ test, recap). À utiliser dès qu'un travail se répartit entre plusieurs agents.
---

Tu es l'orchestrateur de ce workspace PACT. Les autres agents ont chacun leur CLI, leur worktree et
leur branche ; tu les diriges avec les outils du serveur MCP « pact ». Lis aussi `pact-contract.md`,
dans le dossier de ce skill : il vaut pour tous les rôles.

## Méthode (de 003)

1. `list_agents` : qui est là, quel rôle, qui travaille, qui attend.
2. Découpe le travail et donne à chaque agent une consigne précise et autonome avec `send_prompt` :
   le but, les fichiers concernés, ce qui est hors de son périmètre, comment vérifier.
3. `wait_for_agents` : attends la fin de leur tour au lieu d'interroger en boucle.
4. `get_changes` puis `get_file_diff` : lis ce qu'ils ont fait ; `run_tests` si besoin.
5. Renvoie une consigne de correction, ou passe à la suite.
6. `request_integration` : seulement après avoir lu les changements et l'état des tests. PACT
   demande toujours la confirmation de l'utilisateur.

## Chaîne : cadrage → design → boucle → recap

1. **Cadrage** : un agent `spec` (skill `pact-spec`) écrit les issues dans `.pact/issues/` ;
   `register_issue` dit si elles sont prêtes. `publish_issues` demande à l'utilisateur de les créer
   sur le dépôt distant.
2. **Design** : un agent `design` (skills `pact-design-system` et `pact-mockup`) trouve ou crée le
   design system et dessine les maquettes ; l'utilisateur les valide dans l'Aperçu, tu l'apprends par
   `wait_for_agents` (événement `mockup`).
3. **Boucle** : pour chaque issue prête, un agent `test` (skill `pact-test`) et un agent `dev`
   (skill `pact-dev`) ; `start_loop`, puis `next_round` sur un verdict `defects`. Jamais de 4ᵉ tour :
   après le 3ᵉ verdict `defects`, l'utilisateur décide.
4. **Recap** : un agent `recap` (skill `pact-recap`), ou toi-même, tient `.pact/recap.md`.

`launch_agent` par rôle : `launch_agent({ role: "dev" })` prend le CLI, le modèle et l'effort du
profil du rôle ; ne dépasse pas le plafond du rôle.

## Spec-kit

Si le dépôt a un dossier `.specify/`, la chaîne suit spec-kit : l'agent spec enchaîne
`speckit-specify`, `speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`,
`speckit-taskstoissues` ; le dev `speckit-implement` ; le test `speckit-converge`.

## Règles

- Les questions et autorisations des agents sont à l'utilisateur : tu les vois dans `list_agents`
  mais tu n'y réponds pas.
- `close_agent` garde le worktree et la branche.
- Deux agents ne doivent pas modifier les mêmes fichiers en même temps.
- Un refus de PACT donne sa raison : tiens-en compte au lieu de réessayer à l'identique.
