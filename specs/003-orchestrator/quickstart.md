# Quickstart: Orchestrateur

Guide de validation de 003. Installation et commandes : `specs/001-agent-workspace-core/quickstart.md`.

## Prérequis

- Node 22, git ≥ 2.40, `npm ci`.
- Pour la validation manuelle : Claude Code 2.1 ou plus récent, connecté ; un second CLI (Codex ou
  Claude Code).

## Automatisé

```bash
npm run check      # types, lint, format, unit + integration, coverage
npm run test:e2e   # Playwright Electron, with the fake CLI
```

| Domaine | Ce que les tests prouvent |
|------|----------------|
| Protocole MCP (R1) | `initialize`, `ping`, `tools/list`, `tools/call` ; une notification reçoit 202 ; `GET` reçoit 405 ; une méthode inconnue reçoit -32601 |
| Sécurité (R3) | sans jeton, avec un mauvais jeton, après retrait du rôle : 401 ; `Host` non local ou `Origin` présent : 403 ; aucun agent d'un autre workspace n'est désignable |
| Plugin (R2) | `plugin.json`, `SKILL.md` et `.mcp.json` écrits à chaque démarrage, avec l'URL du moment ; le jeton n'apparaît ni dans les fichiers ni dans les arguments |
| Consignes (R4) | une consigne de l'orchestrateur attend la fin d'une question ; deux consignes passent en deux tours ; `orchestrator:prompted` est émis à la frappe ; le retrait du rôle vide la file |
| Attente (R5) | réveil à la fin d'un tour en moins de 2 s ; délai écoulé : `timedOut` ; les événements entre deux attentes ne sont pas perdus |
| Intégration (R6) | la branche principale ne bouge pas avant la confirmation ; confirmer intègre ; refuser n'intègre rien ; l'issue arrive comme événement ; une nouvelle demande remplace l'ancienne ; les demandes reviennent après un redémarrage |
| Lancer et fermer (R7) | mêmes refus que le lanceur ; fermer garde le worktree et la branche |

Les tests de bout en bout suivent les user stories avec un faux orchestrateur, dont les étapes
`mcp` appellent les outils :

| Test | Scénario |
|------|----------|
| `us13-orchestrator.spec.ts` | lancement avec « Orchestrateur », disposition « chef au centre », deux consignes reçues par deux agents, marque sur leurs tuiles |
| `us14-orchestrator-follow.spec.ts` | attente réveillée par la fin de tour d'un agent, lecture de ses changements |
| `us15-orchestrator-integrate.spec.ts` | demande dans À faire, branche principale inchangée, confirmation, commit, événement `integrated` reçu par le faux orchestrateur |
| `us16-orchestrator-agents.spec.ts` | lancement et fermeture d'un agent par l'orchestrateur, worktree conservé |
| `us17-orchestrator-control.spec.ts` | journal des actions, retrait du rôle, retour à la grille, refus suivants |

## Validation manuelle (macOS et Windows)

1. Ouvrir un dépôt avec un projet Node et un script `test`. Lancer un Claude Code coché
   « Orchestrateur » et deux autres agents. Vérifier la disposition.
2. Dans le terminal de l'orchestrateur, demander : « Répartis entre les deux agents l'ajout d'une
   fonction et de ses tests, attends-les, vérifie leurs changements et demande l'intégration du
   meilleur. »
3. Vérifier :
   - aucune demande d'autorisation pour les outils PACT ;
   - les consignes dans les terminaux des agents, avec la marque ;
   - le journal « ◎ Actions » ;
   - la demande dans À faire, et `main` inchangée tant qu'elle n'est pas confirmée.
4. Confirmer, et vérifier le commit et l'événement reçu par l'orchestrateur.
5. Retirer le rôle : l'orchestrateur reçoit des refus, la grille du socle revient.
6. Consigner dans la PR la version de Claude Code, et la prise en compte de `MCP_TOOL_TIMEOUT` pour
   une attente de plus de 60 s (R5).
