# Contrat : interface

Pas de maquette dédiée : cette page en tient lieu (spec, Références UI). Composants existants (`dialog.tsx`,
`tabs.tsx`, `checkbox.tsx`, `button.tsx`, `badge.tsx`, `tooltip.tsx`), libellés concis selon
`docs/maquettes/CONSIGNES-UI.md`.

## Accès

- Bouton « Réglages » dans la barre du haut, sur l'accueil et dans un workspace ; il porte un point quand l'avis de
  R18 est actif.
- Sur l'accueil, « N worktrees conservés » devient un bouton : il ouvre « Réglages », onglet « Stockage », filtré sur
  ce projet (US1 sc.6). Un filtre actif se retire par « Tous les projets ».
- Avis (R18) : une ligne sous l'en-tête de l'accueil, `◆ 6,2 Go supprimables · Voir le stockage`, sans bouton de
  suppression.

## Onglet « Stockage »

```text
┌ Réglages ─────────────────────────────────────────────────────────────┐
│ [Stockage]                                                            │
│ Total 7,1 Go · Récupérable 1,4 Go · Supprimable sur confirmation 6,6 Go│
│ estimation ⓘ   état des branches connu au 08/11 09:12, sans fetch ⓘ    │
│ [Nettoyer · 1,4 Go]            Filtre : [Tous les projets ▾]          │
│ ▾ PACT  ~/Développement/PACT                      6,9 Go             │
│   ☐ claude-code-2   agent/claude-code-2 · dev · fermé · PR #61 fusionnée│
│                     2 modifiés · 1 non poussé · 07/11 22:40  750 Mo ✓ sûr│
│   ☐ codex-3         … · aucun agent · PR inconnue          calcul…      │
│   ·  pact-main      ~/.claude/jobs/…  lecture seule · worktree externe  │
│   Entrées Git mortes (2)                         [Retirer…]            │
│ ▸ ancien-projet  (absent du disque)  données 12 Ko                     │
│ ▸ Application  caches 18 Mo · rôles orphelins 80 Ko · sauvegardes 2 Ko  │
│ [Supprimer la sélection · 2 éléments · 1,5 Go]                         │
│ Avis : ☑ au-delà de [ 5 ] Go supprimables                               │
└───────────────────────────────────────────────────────────────────────┘
```

- Une ligne par projet (US1 sc.1), dépliable (sc.2). Projet fermé : affiché ; absent : `(absent du disque)`, ses
  données seules (sc.5). Ligne « Application » pour les éléments de `<userData>`.
- Ligne de worktree : nom du dossier, branche réelle, rôle, état de l'agent ou `aucun agent`, `PR #n <état>` ou
  `PR inconnue`, fichiers modifiés, commits non poussés, date du dernier changement, taille, badge `✓ sûr` (US2 sc.1).
  Une ligne d'ancienne version porte `ancienne version`.
- Taille inconnue : `calcul…` ; erreur de lecture : `illisible` avec l'erreur en infobulle (Edge Cases).
- `·` en tête et texte grisé : lecture seule, avec la raison (`worktree externe`, `inconnu de Git`, `lien symbolique`,
  `jamais supprimé`, `non pris en charge`). Aucune case.
- Agent dont le processus tourne : case désactivée, `◆ en cours · fermez-le d'abord`.
- Les totaux et la sélection se mettent à jour au fil du calcul ; l'interface reste utilisable (US1 sc.3).
- « Nettoyer » sélectionne les éléments `✓ sûr` et ouvre la confirmation ; désactivé avec `Rien de sûr` si aucun
  (US4 sc.6). « Nettoyer » ne propose jamais l'orchestrateur ni une ancienne version.

## Confirmation

Titre : `Supprimer 2 éléments · 1,5 Go`. Pour chaque élément :

```text
claude-code-2 · agent/claude-code-2
  Irrécupérable : 2 fichiers modifiés — src/a.ts, src/b.ts
                  1 commit absent de toute branche distante — 3f2a9c1 « Ajoute le parseur »
  Récupérable   : 1 commit sur origin/agent/claude-code-2 — 9b1e004 « … »
  Non suivis PACT : .pact/issues/i-12.md, design/mockups/home.html
  Ignorés : 742 Mo, dont .env.local
  ☐ Supprimer aussi la branche distante origin/agent/claude-code-2 (PR #61 fusionnée)
```

- Rien de perdu : `Rien d'irrécupérable.`
- Confirmation renforcée (FR-010) : `Tapez « orchestrator-1 » pour confirmer` ; le bouton reste désactivé tant que le
  texte diffère ; la liste `.pact/` est complète.
- Élément hors worktree : son effet (`PACT devra redémarrer`, `Ses issues, boucles et réglages partent`).
- Boutons : `Annuler` (défaut, Échap) et `Supprimer`. Annuler ne change rien (US3 sc.2).
- Entrées mortes : `Retirer 2 entrées Git mortes de PACT` avec leurs noms et chemins manquants ; une entrée verrouillée
  est citée « gardée : verrouillée ».

## Résultat

Un récapitulatif dans l'onglet : `✓ 3 supprimés · 1,4 Go libérés`, puis une ligne par échec ou refus avec sa raison
(`changé depuis la confirmation : à confirmer de nouveau`, `fichier verrouillé : <message>`, `déjà supprimé`). Un
cache supprimé ajoute `Relancer PACT maintenant` et `Plus tard` (R12).

## IPC

| Canal | Sens | Charge | Réponse |
|---|---|---|---|
| `storage:open` | requête | `{ projectId: string \| null }` | `{ items: StoredItem[], worktrees: Record<id, WorktreeInfo>, totals }` (sans tailles) |
| `storage:close` | requête | — | `void` ; interrompt le calcul |
| `storage:sizes` | événement | `{ id, size, error }[]` et `totals` | — |
| `storage:confirm` | requête | `{ ids: string[] }` | `Loss[]` |
| `storage:remove` | requête | `RemovalRequest` | `RemovalResult[]` |
| `storage:prune` | requête | `{ projectId }` | `{ removed: string[], kept: { name, reason }[] }` |
| `storage:clean` | requête | `{ projectId: string \| null }` | `string[]` : ids sûrs (ne supprime rien) |
| `storage:notice` | événement | `{ deletable: number } \| null` | — |
| `settings:storageNotice` | requête | `StorageNotice` | `StorageNotice` enregistré |
| `app:relaunch` | requête | — | `void` |

Tous validés par Zod des deux côtés (`src/shared/ipc.ts`). Aucun canal n'est exposé aux agents (R16).

## Accessibilité

Liste en `role="tree"` par projet, cases atteignables au clavier (Espace coche, Entrée déplie), totaux en
`aria-live="polite"` limités à une annonce par seconde, confirmation en `role="alertdialog"`, focus sur `Annuler`.
L'audit axe de 006 (`tests/e2e/helpers/a11y.ts`) couvre l'onglet et la confirmation. SC-006 au clavier : Tab jusqu'à
« Nettoyer », Entrée, Tab jusqu'à « Supprimer », Entrée.
