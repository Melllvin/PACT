# Quickstart: Revue et intégration

Guide de validation de 002. L'installation et les commandes sont les mêmes que dans
`specs/001-agent-workspace-core/quickstart.md`.

## Prérequis

- Node 22, git ≥ 2.40, `npm ci`.
- macOS et Windows : chaque scénario ci-dessous tourne sur les deux (SC-007).

## Automatisé

```bash
npm run check      # types, lint, format, unit + integration (real git repositories), coverage
npm run test:e2e   # Playwright Electron, with the fake CLI
```

Suites d'intégration attendues (elles tournent sur des dépôts temporaires, R11) :

| Domaine | Ce qu'elle prouve |
|------|----------------|
| Instantané (R1) | les fichiers commités, non commités, non suivis et renommés sont tous dans la revue ; les fichiers ignorés n'y sont pas ; l'index et les fichiers de l'agent ne sont pas touchés |
| Diff (R2) | les fichiers binaires et gros sont signalés ; une différence CRLF/LF seule ne change rien ; les chemins accentués et avec espaces fonctionnent |
| Conflits (R4) | la vérification laisse `main`, son dossier et le worktree inchangés octet pour octet |
| Intégration (R5) | le squash donne un commit ; keep-commits garde les commits de l'agent ; des changements locaux sur des fichiers touchés bloquent avec la liste ; l'échec et l'annulation laissent `main` inchangée (SC-003) ; deux intégrations se font l'une après l'autre |
| Résolution (R6) | chaque choix donne le contenu attendu ; des marqueurs restants signifient non résolu ; l'annulation laisse tout comme avant |
| Consignes (R7) | rien n'est tapé tant que l'agent est en `awaiting-answer` ; la consigne est tapée en `awaiting-prompt` |
| Tests (R8) | détection depuis `package.json` ; réussi et en échec selon le code de sortie ; le nombre est lu ; le délai max et l'annulation fonctionnent ; le résultat devient ancien quand l'instantané change |

Les tests e2e suivent les user stories avec le faux CLI, qui écrit et commite des fichiers :

1. **US1 :** « Revue → » ouvre Changements. La liste des fichiers et les totaux sont justes. « vu »
   compte, et une modification ultérieure par l'agent affiche « Nouveaux changements ».
2. **US2 :** « ✓ Intégrer » en squash fait un commit sur `main`. La tuile se ferme et le worktree
   est supprimé. La notification « ✓ Intégré » s'affiche.
3. **US3 :** un commentaire arrive dans l'invite du faux CLI avec son fichier et sa ligne, de même
   que les raccourcis.
4. **US4 :** une `main` en conflit ouvre l'écran de conflit. Résoudre à la main puis terminer donne
   le commit attendu, et « Annuler » ne change rien.
5. **US5 :** le badge Revue compte 2, les pastilles passent d'un agent à l'autre, et
   « Abandonner » laisse `main` inchangée.

## Manuel (avec les vrais CLI)

1. Ouvrir un dépôt Node qui a un script `test`. Lancer un agent Claude Code : « ajoute une
   fonction et son test, sans commiter ».
2. Quand il a fini, cliquer « Revue → ». Attendu : « Tests : N réussis », et les nouveaux fichiers
   dans la liste.
3. Commenter une ligne. Claude Code reçoit « Commentaire sur <fichier>:<ligne> — … » et corrige.
   La revue se met à jour d'elle-même en moins de 3 s.
4. Commiter sur `main` un changement qui touche la même ligne, puis cliquer « Intégrer ». L'écran
   de conflit s'ouvre. Cliquer « Demander à l'agent » ; l'agent met sa branche à jour et résout.
   Cliquer de nouveau « Intégrer » : un commit sur `main`.
5. Recommencer avec Codex sous Windows, dans un dépôt dont le chemin contient espaces et accents.

Le commit d'intégration passe par les crochets `pre-commit` et `commit-msg` du dépôt (R5). Pour le
vérifier, ajouter un crochet `pre-commit` qui sort avec 1 et cliquer « Intégrer » : l'intégration
échoue avec la sortie du crochet, et `main` ne bouge pas.
