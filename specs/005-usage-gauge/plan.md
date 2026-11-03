# Implementation Plan: Jauge de limite d'usage

**Branch**: `005-usage-gauge` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-usage-gauge/spec.md`

## Summary

PACT lit les limites d'usage d'abonnement de Claude Code et de Codex sans rien demander au CLI de plus
que ce qu'il produit déjà, les affiche en jauges dans la barre du workspace, alerte dans À faire et au
lancement, répartit la consommation par agent, et donne à la reprise automatique (001 FR-036) l'heure
de réinitialisation connue.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Lecture Claude Code | `--settings` par agent, pont de hooks, `HookServer` (001) | `statusLine` de session → route `/statusline` (R1) |
| Lecture Codex | identifiant de session connu (001), dossier `~/.codex/sessions` | lecteur des `token_count` du rollout (R2) |
| État des limites | `Clock` d'`AutoResume` | `UsageService` (fenêtres, âge, parts, seuils) (R3–R5) |
| Alertes | `todo.ts` (ordre, dédoublonnage par clé) | type `usage-limit` (R6) |
| Lanceur | avertissements non bloquants du lanceur (001) | avertissement de limite ; refus d'outil MCP inchangé, simple texte ajouté (R7) |
| Reprise | `nextResume(agentId, resetAt, …)` | `resetAt` de repli depuis `UsageService` (R8) |
| Seuils | `AppState` (persistance JSON) | `usageThresholds` |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS.

**Primary Dependencies**: aucune nouvelle.

**Storage**: `AppState.usageThresholds` (défaut `{ warn: 80, critical: 95 }`). Les lectures et parts
restent en mémoire : elles n'ont de sens que pour la fenêtre courante (R5).

**Testing**: Vitest (analyse des charges utiles Claude et Codex, choix de la fenêtre affichée, âge,
seuils, parts, repli de reprise), intégration (route `/statusline`, lecteur de rollout sur un dossier
temporaire), Playwright Electron avec de nouvelles étapes du faux CLI (`usage` : pousse une charge
`statusLine` ; `rollout` : écrit un `token_count`), caractérisation sur vrais CLI (T049 de 001).

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11 ; Claude Code 2.1+, Codex 0.163+.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: jauge à jour < 1 min pendant le travail (SC-003) ; coût de lecture nul côté
quota (aucune requête au modèle, SC-004).

**Constraints**:
- aucun fichier de configuration personnelle des CLI créé ou modifié (FR-005) : la `statusLine` passe
  par `--settings` de session, la lecture Codex est en lecture seule ;
- aucun secret lu ni stocké (pas d'appel direct aux API des fournisseurs) ;
- un échec de lecture ne lève jamais d'erreur visible (FR-004).

**Scale/Scope**: 2 sources, 2 à 4 fenêtres par CLI, 1 service, 1 canal d'événement, 2 canaux de
requête, 1 type d'élément À faire, 1 composant de jauge.

Aucun « NEEDS CLARIFICATION » : les sources ont été sondées sur Claude Code 2.1.316 et Codex 0.163.0
(research.md R1, R2). Reste à caractériser sur vrais CLI : présence de `rate_limits` hors abonnement,
écart avec `/usage` et `/status` (SC-002).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque story commence par ses tests : analyse des charges (fixtures réelles anonymisées), `UsageService` avec horloge factice, route `/statusline`, lecteur de rollout, puis e2e avec le faux CLI. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Inchangé : `check`, `e2e` macOS et Windows, `coverage-guard` ; une PR par phase. | ✅ |
| III. Zéro régression | Couverture non décroissante | `AppState` lu sans migration (défaut) ; `nextResume` garde sa signature, le repli est passé par l'appelant ; les tests de reprise de 001 restent. | ✅ |
| IV. Réutiliser | Inventaire, justification | Voir le tableau du Summary. **Nouveau** sans équivalent : `UsageService` et le lecteur de rollout Codex, injectés comme les services de 002 et 003. | ✅ |
| V. Qualité | Lint, format, YAGNI | Aucune dépendance. Pas de requête aux API des fournisseurs, pas d'historique au-delà de la fenêtre courante, pas de jauge pour « Autre CLI ». | ✅ |

**Re-check post-design (Phase 1)** : data-model et contrats n'ajoutent qu'un service, un lecteur, une
route et trois canaux IPC. ✅

## Project Structure

### Documentation (this feature)

```text
specs/005-usage-gauge/
├── plan.md
├── research.md          # R1–R9
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── sources.md       # charges lues : statusLine Claude Code, token_count Codex
│   └── ipc.md           # canaux ajoutés à src/shared/ipc.ts
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── agents/
│   │   ├── adapters/types.ts           # + usageSource?: 'statusline' | 'codex-rollout'
│   │   ├── adapters/claude-code.ts     # + statusLine de session (pont, --statusline) (R1)
│   │   ├── adapters/fake.ts            # + étapes usage / rollout
│   │   ├── hook-bridge.ts              # + --statusline : poste sur /statusline, imprime la réponse
│   │   ├── hook-server.ts              # + route /statusline (jeton d'agent)
│   │   └── agent-manager.ts            # reprise : resetAt de repli (R8)
│   └── usage/
│       ├── usage-service.ts            # lectures, fenêtres, parts, seuils, événements (R3–R6)
│       ├── claude-statusline.ts        # charge statusLine → lecture (pur)
│       └── codex-rollout.ts            # suivi du rollout d'une session → lecture (R2)
├── shared/
│   ├── usage.ts                        # schémas zod, fenêtre affichée, niveau, âge (pur)
│   ├── todo.ts                         # + usage-limit
│   └── ipc.ts                          # + usage:state, usage:get, settings:usageThresholds
└── renderer/
    ├── workspace/UsageGauge.tsx        # jauge, détail (popover), accessibilité
    ├── launch/                         # avertissement de limite
    ├── settings/UsageThresholds.tsx
    └── store/app-store.ts

tests/
├── unit/shared/usage.test.ts
├── unit/main/usage/claude-statusline.test.ts, codex-rollout.test.ts, usage-service.test.ts
├── integration/usage/statusline-route.test.ts, rollout-follow.test.ts
├── unit/renderer/workspace/UsageGauge.test.tsx
├── e2e/us24-usage-gauge.spec.ts … us27-*.spec.ts
└── fixtures/usage/                     # charges réelles anonymisées
```

**Structure Decision**: même projet Electron ; `main/usage/` regroupe la lecture et l'état, car ils
servent la barre, À faire, le lanceur, l'orchestrateur et la reprise.

## Complexity Tracking

Aucune violation.
