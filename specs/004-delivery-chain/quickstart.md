# Quickstart: Chaîne de livraison

Guide de validation. Détails : [contracts/](contracts/), [data-model.md](data-model.md).

## Prérequis

- `npm ci`, puis `npm run build`.
- Pour la validation manuelle : Claude Code 2.1+ et Codex 0.163+ connectés, `gh` connecté, un dépôt
  de test avec un remote GitHub jetable.

## Automatisé

```bash
npm run check        # unitaires, intégration, couverture
npm run test:e2e     # dont us18…us23 (004)
```

| Story | Preuve automatisée |
|-------|--------------------|
| US1 rôles et profils | lancement par un faux orchestrateur d'un dev et d'un test : CLI, modèle, effort du profil, libellé de tuile ; refus au-delà du plafond ; avertissement test < dev |
| US2 boucle | scénario `loop-fail-always` : arrêt au 3ᵉ tour, élément « ✕ Boucle arrêtée » ; `loop-pass-round-2` : « faite » seulement après un run PACT à 0 ; test qui touche `src/` : verdict rejeté |
| US3 cadrage | `register_issue` refuse « prête » sans critères ; `start_loop` refusé sur une issue non prête ; `publish_issues` → élément « ◎ Créer N issues ? », aucun `gh` lancé avant confirmation (faux `gh` dans le PATH) |
| US4 design | maquette du faux agent dans l'Aperçu, police et script distants bloqués, zéro requête réseau ; « ✓ Valider » + commentaire → événement `mockup` |
| US5 recap | `.pact/recap.md` écrit par le faux agent, rafraîchi en < 2 s dans l'Aperçu, position de lecture gardée |
| US6 universalité | skills par rôle copiées hors de la configuration (`skills-delivery`), contrats Claude Code (`--plugin-dir`) et Codex (`developer_instructions`, serveur `pact`) ; CLI générique : `.pact/ROLE.md` exclu de Git et lu au démarrage (`us23-skills`) |
| FR-032 | `paths.spec.ts` : skills, maquette et recap avec dépôt et données de PACT sous des chemins à espaces et accents |
| SC-007 | chaque fichier de test (Vitest) et chaque lancement e2e a son propre `HOME` ; échec si un `.claude` ou `.codex` y est écrit |
| FR-006a | grille « chef » à 1, 3 et 5 agents, fenêtre 1280×800 et 2560×1440 : aire de la tuile du chef > aire de chaque autre |

## Manuel (consigné dans la PR)

1. Régler les profils : orchestrateur Claude Code `opus`/high, dev Codex modèle moyen, test Claude
   `sonnet`, recap `haiku`.
2. Lancer un orchestrateur, taper `/pact:pact-orchestrator` (Claude Code) et décrire une petite fonctionnalité avec une
   interface.
3. Vérifier : questions, issues dans `.pact/issues/`, « ◎ Créer N issues ? » ; confirmer ; issues sur
   GitHub.
4. Vérifier l'agent design : design system créé ou réutilisé, maquette dans l'Aperçu, validation.
5. Vérifier la boucle : tests d'acceptation rouges par le test, dev, « tour N/3 », preuve par PACT.
6. Lire `.pact/recap.md` dans l'Aperçu de l'orchestrateur : « À tester à la main » présent.
7. Refaire 2 et 5 avec un orchestrateur Codex (R4).
8. Vérifier que `~/.claude/settings.json`, `~/.codex/config.toml` et les `AGENTS.md` du dépôt n'ont pas
   changé.
9. Refaire sur Windows, dans un dossier avec espaces et accents.
