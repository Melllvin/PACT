# Quickstart — valider le socle 001

Guide de validation de bout en bout. Détails : [data-model.md](data-model.md),
[contracts/cli-adapter.md](contracts/cli-adapter.md), [contracts/ipc.md](contracts/ipc.md).

## Prérequis

- macOS 13+ ou Windows 10 (1809+) / 11.
- Node 22 LTS, npm 10+, Git ≥ 2.40.
- Windows : outils de compilation C++ (Visual Studio Build Tools, charge « Desktop C++ ») pour
  node-pty. macOS : Xcode Command Line Tools.
- Optionnel pour la validation manuelle : Claude Code ≥ 2.1 et Codex récent (avec hooks ; la
  version 0.39 est trop ancienne → `npm i -g @openai/codex@latest`), connectés.

## Installation et vérifications

```bash
npm ci                 # installe et recompile node-pty pour Electron
npm run check          # typecheck + lint + format + tests unitaires/intégration + couverture
npm run test:e2e       # Playwright sur Electron avec le faux CLI
npm run dev            # lance l'application en développement
```

Critère : les trois commandes passent sur macOS et sur Windows (SC-006). En CI, la matrice GitHub
Actions exécute `check` et `e2e` sur les deux OS.

## Scénarios automatisés (faux CLI)

Le faux CLI (`tests/fixtures/fake-cli/`) rejoue un scénario JSON. Scénarios minimaux :

| Scénario | Vérifie | Réf. |
|----------|---------|------|
| `prompt-then-done` | invite → consigne → travail → Stop ; élément « Donner une consigne » puis disparition | US2 sc. 6, US3 sc. 2 |
| `ask-permission` | question d'autorisation → ◆ dans À faire et sur la tuile → Autoriser → reprise | US3 sc. 5, US4 sc. 1–2 |
| `crash-exit-1` | arrêt code 1 → halo rouge, Journal / Relancer / Reprendre | US3 sc. 6 |
| `rate-limit` | reprise auto activée en amont → limite avec heure de levée → « reprise auto à HH:MM » sans question → reprise ; variante processus vivant (« continue ») et variante reprise native du CLI (pas de double reprise) | US7 |
| `rename-branch` | l'agent renomme sa branche → l'infobulle ⎇ suit | US3 sc. 3 |

Assertions e2e principales : grille 2×2 / 3×2 selon le nombre d'agents ; ports 3001…3006 ;
couleurs dans l'ordre Purple → Slate ; `.worktrees/` absent de `git status` du dépôt principal ;
restauration après redémarrage (SC-005) ; ◆ puis ✕ sur l'onglet inactif.

## Validation manuelle avec de vrais CLI

1. `npm run dev`, glisser un dépôt de test sur l'accueil → onglet ouvert, état vide (1b).
2. « + Ajouter des agents » → 2 Claude Code, 1 Codex, 1 terminal libre → « Lancer 4 agents ».
3. Premier lancement : écran d'autorisations, choisir « Demander pour les actions sensibles »,
   laisser « Reprendre automatiquement après une limite de débit » activé, portée « Ce projet »,
   Entrée.
4. Vérifier : 4 éléments dans À faire, `git worktree list` montre 3 worktrees sous `.worktrees/`,
   `git status` du dépôt principal est propre.
5. Donner à un agent une consigne qui supprime un fichier hors worktree → ◆ attend ; répondre
   depuis À faire → la tuile se met à jour.
6. Ouvrir le Focus (⤢), changer d'agent via les pastilles, Échap → grille intacte.
7. Tuer le processus d'un agent (`kill` / Gestionnaire des tâches) → halo rouge → « Reprendre ».
8. Quitter et relancer l'app → workspace et agents restaurés, mêmes couleurs, branches, ports.
9. macOS : lancer l'app packagée depuis le Finder → Claude Code et Codex détectés.
