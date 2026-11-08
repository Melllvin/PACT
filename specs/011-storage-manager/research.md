# Research: Gestionnaire de stockage

Décisions du plan, appuyées sur le code de `main` au 2026-11-08 (`8315ff26`) et sur le plan de 008 (`origin/008-plan`,
`b401db8c`). La spec fait foi ; un point qu'elle ne tranche pas est en fin de page, avec une recommandation.

## R1 — Base et découpage

- **Decision** : implémentation sur `011-storage-manager`, depuis `origin/main`. Les Phases 2 à 5 (vue, détail,
  suppression, protections) ne dépendent pas de 008. La Phase 6 (« Nettoyer », avis) attend que 008 soit fusionnée :
  elle lit `workspace.deliveries`, `GhClient.prView` et les conditions de `WorktreeCleanup`.
- **Rationale** : spec, Dépendances : « Les vues et la suppression à l'unité ne dépendent pas de 008, l'action
  « Nettoyer » si ». Livrer la vue tôt donne déjà la place visible (US1, P1).
- **Alternatives** : tout après 008 (retarde la vue sans raison) ; recopier les critères de 008 dans 011 (deux règles
  qui divergeront : refusé, constitution IV).

## R2 — Un service, un inventaire, un calcul de tailles

- **Decision** : trois modules dans `src/main/storage/` :
  - `inventory.ts` : construit la liste des éléments (worktrees et éléments de `<userData>`), sans taille, en lectures
    seules. Rapide : `readdir`, `lstat`, `git worktree list`, pas de parcours d'arborescence.
  - `sizer.ts` : calcule les tailles par parcours asynchrone (`fs.promises.opendir`, `lstat`, jamais de suivi de lien),
    élément par élément, interrompu par un `AbortSignal`.
  - `storage-service.ts` : état en mémoire de la vue, émission des mises à jour, confirmation, suppression, avis.
  La logique pure (propriété, verdicts, pertes, totaux, empreinte) va dans `src/shared/storage.ts`.
- **Rationale** : SC-001 exige l'affichage avant la fin des tailles : l'inventaire part d'abord, les tailles le
  remplissent ensuite (FR-003). Les règles pures sont testables sans disque (constitution I).
- **Alternatives** : `du` ou `dir /s` (différents par plateforme, non interruptibles proprement, sortie à parser) ;
  un seul service (trop gros, tests lents).

## R3 — Ne pas bloquer, s'arrêter quand on ne regarde plus (FR-003, US1 sc.3)

- **Decision** : parcours asynchrone dans le processus principal, une file de 4 lectures `lstat` en parallèle au plus,
  et un `setImmediate` tous les 500 fichiers, pour laisser passer l'IPC et les PTY. Les tailles partent par lots sur
  `storage:sizes`, au plus toutes les 250 ms. La vue s'abonne par `storage:open` et se désabonne par `storage:close`
  (fermeture de l'onglet ou du dialogue) : le calcul en cours est interrompu par son `AbortSignal`. Une taille non
  encore connue vaut `null`, affichée « calcul… ».
- **Basse priorité** (FR-003, Q16, FR-020) : au démarrage (30 s après `ready`) et après une fusion constatée (008
  `onMerged`), un calcul pour les seuls éléments « supprimables sur confirmation », une lecture à la fois et une pause de
  5 ms tous les 200 fichiers. Résultat gardé en mémoire, jamais écrit.
- **Rationale** : Node fait le travail d'entrée-sortie hors du fil principal ; la boucle d'événements reste libre si
  l'on ne garde pas de longue suite synchrone. Pas de `worker_threads` : il ne ferait que déplacer les mêmes appels
  `fs`, et compliquerait l'abandon et les tests.
- **Alternatives** : `utilityProcess` ou `worker_threads` (voir point ouvert O6 si la mesure de SC-001 échoue) ;
  cache de tailles persistant (interdit : Assumptions, « sans cache persistant », et FR-004).

## R4 — Liens durs et place gagnée (Edge Cases)

- **Decision** : un ensemble `dev:ino` par calcul ; un fichier déjà vu n'est pas recompté dans le total global. La
  taille d'un élément compte tous ses fichiers. La vue affiche « estimation » à côté des totaux, avec une infobulle :
  « Des fichiers partagés entre éléments (liens durs) ne libèrent leur place qu'avec le dernier. »
- Taille = `blocks × 512` quand `blocks` est donné (macOS), sinon `size` (Windows). C'est la place occupée, pas la
  taille logique.
- **Alternatives** : taille logique seule (sous-estime les petits fichiers de `node_modules`).

## R5 — Lire sans rien écrire (FR-004, SC-002, US1 sc.4)

- **Decision** : toutes les commandes Git de lecture de 011 passent par une méthode `readOnly` de `GitService` qui
  ajoute `GIT_OPTIONAL_LOCKS=0` à l'environnement et `--no-optional-locks` en tête, et ne lance jamais `fetch`,
  `remote show`, `gc`, `maintenance` ni `status` sans ces options. Les commandes :
  - worktrees : `git worktree list --porcelain -z` (champs `worktree`, `HEAD`, `branch`, `detached`, `locked`,
    `prunable`) ;
  - état : `git status --porcelain=v2 -z --branch --untracked-files=all --ignored=matching` dans le worktree ;
  - commits non poussés : `git rev-list --reverse <HEAD> --not --remotes` (références distantes déjà connues, FR-006),
    puis `git log --no-walk --format=%H%x00%s%x00%cI` sur ces commits, borné à 50 ;
  - commits présents ailleurs : `git branch -r --contains <sha>` pour chaque commit cité (récupérable, Q14) ;
  - date : `git log -1 --format=%cI HEAD` et le plus récent `mtime` des fichiers rendus par
    `git ls-files -z --cached --others --exclude-standard` (Q10), lus par `lstat` ;
  - fichiers ignorés : les lignes `!` du `status` ; leur taille vient du calculateur (R3), et les `.env*` sont cités
    par nom (Q11, même motif que 008 `statusIgnored`).
- **Test** (SC-002) : une empreinte du dépôt temporaire avant et après (tous les fichiers de `.git`, leur taille et
  leur `mtime`, l'index, `git for-each-ref`, plus l'arborescence de chaque worktree) ; égalité exigée.
- **Alternatives** : `git status` simple (rafraîchit l'index, donc écrit : refusé) ; `isomorphic-git` (nouvelle
  dépendance, refusé par constitution IV).

## R6 — Ce que PACT a créé (FR-011, Q7, Q15, US5)

- **Decision** : `owned(item)` dans `src/shared/storage.ts`, appelé avec des chemins déjà résolus par
  `realpath.native` côté main :
  - **Worktree** : `lstat(path)` n'est pas un lien ; `realpath(path)` a pour parent exact `realpath(<dépôt>/.worktrees)`,
    ou `realpath(<userData>/integrations)` ; et ce même chemin figure dans `git worktree list` du dépôt du projet. Le
    dossier du dépôt principal (première entrée de la liste) n'est jamais pris.
  - **Élément de `<userData>`** : `realpath(path)` est exactement le chemin d'inventaire (table de R8), et `lstat`
    n'est pas un lien. Un lien à ce chemin rend l'élément `readOnly`, raison « lien symbolique » (O3).
  - Le reste : un worktree hors `.worktrees/` (comme `~/.claude/jobs/…/tmp/pact-main`) ou un dossier de `.worktrees/`
    inconnu de Git est affiché `readOnly` ; `~/.claude`, `~/.codex`, le dépôt principal ne sont pas listés.
- Le contrôle est refait juste avant la suppression (R10), pas seulement à l'inventaire.
- **Rationale** : le cas réel de la spec (worktree d'un autre outil enregistré par Git) prouve qu'une seule des deux
  preuves ne suffit pas.

## R7 — Projets couverts (FR-001, Q9, US1 sc.5)

- **Decision** : la liste vient des fichiers `<userData>/workspaces/<hash>.json` lisibles par `workspaceSchema`. Un
  fichier illisible apparaît comme « données illisibles », supprimable seulement par sa sauvegarde `.corrupt-*`
  (`JsonFile` la crée déjà). Pour chaque projet : ouvert (`WorkspaceService.list()`), récent (`state.recents`), fermé,
  ou absent (son `path` n'existe plus ou n'est plus un dépôt). Un projet absent montre ses données, sans worktrees ni
  entrées Git.
- Lecture par `JsonFile.read()` sans écriture : `JsonFile` renomme un fichier illisible en `.corrupt-*`. La lecture de
  011 utilise un `peek()` nouveau, qui parse sans jamais renommer (FR-004).

## R8 — Inventaire hors worktrees (FR-002, Q8, Q15)

| `kind` | Chemin d'inventaire | Supprimable si | Effet annoncé |
|---|---|---|---|
| `electron-cache` | `<userData>/{Cache,Code Cache,GPUCache,DawnGraphiteCache,DawnWebGPUCache,GraphiteDawnCache,Shared Dictionary,blob_storage}` | toujours | relance demandée (R12) |
| `role-orphan` | `<userData>/roles/<agentId>` | aucun agent de cet id dans un fichier de workspace, ni session de `OrchestratorService` | aucun |
| `integration-leftover` | `<userData>/integrations/<id>` (dossier) | aucune intégration en cours (`IntegrationService.pending`), aucune livraison non finale (008) ; s'il est encore enregistré dans un dépôt, il passe par le chemin des worktrees (R6) | aucun |
| `conflict-copies` | `<userData>/conflicts/<id>` | aucun conflit en cours pour cet id | aucun |
| `store-backup` | `<userData>/**/*.corrupt-*`, `<userData>/**/*.<pid>.<n>.tmp` (racine et `workspaces/`) | toujours, `.tmp` d'un `pid` vivant exclu | « sauvegarde d'un fichier illisible » |
| `workspace-data` | `<userData>/workspaces/<hash>.json` | projet ni ouvert ni dans `recents` | « ses issues, boucles et réglages partent » |
| `state` | `<userData>/state.json` | jamais | — |
| `dead-entry` | `<dépôt>/.git/worktrees/<nom>` marqué `prunable` | toujours, sauf `locked` | retiré par `git worktree prune` (R11) |

`<userData>/deliveries/<id>` (008) et `<tmp>/pact-index-*` : listés en lecture seule (O1, O2).

## R9 — La perte annoncée (FR-008, Q11, Q14, US3 sc.1, 5, 7)

- **Decision** : `storage:confirm(items)` rend, pour chaque élément, une `Loss` (data-model) et une empreinte
  `fingerprint` : SHA-256 de `HEAD`, de la branche réelle, de la sortie du `status` (R5), de la liste des non poussés,
  de l'état de l'agent rattaché et de la liste `.pact/` non suivie. La confirmation cite :
  - fichiers modifiés et non suivis (irrécupérables), 20 par catégorie puis « et N autres » ;
  - commits non poussés : sha court, sujet tronqué à 80, `irrécupérable` si `branch -r --contains` est vide, sinon
    `récupérable sur origin/<b>` ; une branche distante cochée dans la même suppression ne compte pas (Edge Cases) ;
  - maquettes et issues non suivies (`.pact/**`, `design/mockups/**`) : nommées à part (US3 sc.5) ;
  - fichiers ignorés : taille totale et chaque `.env*` par nom ;
  - pour un élément hors worktree : l'effet de R8.
- Le sujet d'un commit est écrit par un agent ou par l'utilisateur, jamais par un tiers : 011 ne lit aucun commit d'une
  PR d'un autre auteur (R13). Il est rendu comme texte, jamais comme HTML.

## R10 — Relire juste avant (FR-009, FR-010, US3 sc.4, Edge Cases)

- **Decision** : `storage:remove({ items: [{ id, fingerprint, typed? }], remoteBranches })`. Pour chaque élément, dans
  l'ordre et sans arrêt au premier échec (FR-007) : refaire `owned` (R6), recalculer l'empreinte, relire l'état de
  l'agent dans `AgentManager`, l'intégration et la livraison en cours, chercher un terminal libre dont le `cwd` est
  dans le worktree (`FreeTerminals`). Toute différence → résultat `changed`, rien supprimé, « à confirmer de nouveau ».
- Verrou par élément pendant la suppression : une seconde demande sur le même `id` rend `gone` ou `busy` sans erreur
  bloquante (Edge Cases, deux actions simultanées).

## R11 — Comment supprimer

- **Worktree** : `git worktree remove --force <path>` depuis le dépôt principal, **seulement** après R10 (la perte est
  confirmée et l'empreinte égale). Puis `git branch -D <branche réelle>` si cette branche n'est ni la branche
  principale (`workspace.mainBranch`), ni rattachée à un autre worktree (`worktreeOf`), et qu'elle est bien la branche
  réelle lue à l'instant (Edge Cases). Un échec de `worktree remove` (fichier verrouillé sous Windows) est rendu tel
  quel, sans `rm` en boucle : on ne réutilise pas la branche `catch` de `GitService.removeWorktree`, qui retente un
  `rm` récursif (Edge Cases). Méthode nouvelle `GitService.removeOwnedWorktree`, l'ancienne reste pour `close`.
- **Entrées mortes** (FR-018, US3 sc.6) : la vue montre les entrées `prunable` d'un dépôt (nom, chemin manquant).
  Le geste lance `git worktree prune --expire=now` dans ce dépôt ; une entrée `locked` reste (Edge Cases), et le
  résultat le dit.
- **Élément de `<userData>`** : `rm(path, { recursive: true, force: false })` après `owned` relu ; un lien à ce chemin
  n'est jamais suivi, car il est `readOnly` (R6).
- **Données d'un workspace** : refusé si le projet est ouvert ou récent au moment du geste (relu) ; sinon `rm` du JSON.

## R12 — Caches d'Electron (Q8, US5 sc.10)

- **Decision** : la suppression d'un cache n'est pas faite à chaud. Le geste écrit `<userData>/pending-cleanup.json`
  (liste fermée de noms de R8) puis propose « Relancer PACT maintenant » ou « Plus tard ». Au démarrage, avant
  `app.whenReady`, `index.ts` lit ce fichier, supprime ces dossiers s'ils sont encore aux chemins d'inventaire (R6),
  et retire le fichier. « Relancer » appelle `app.relaunch()` puis `app.quit()` (le garde de fermeture T110 s'applique).
- **Rationale** : Chromium garde ces dossiers ouverts ; les supprimer à chaud peut corrompre le cache en cours.
- **Alternatives** : `session.clearCache()` et `clearCodeCaches()` (ne couvrent ni `GPUCache` ni Dawn) ; supprimer à
  chaud (risque de corruption).

## R13 — État de la PR (FR-005, FR-015, FR-016, Q13, US2 sc.3 à 5)

- **Decision** : la PR liée d'un worktree vient, dans cet ordre, d'une demande de livraison de 008 dont `branch` est la
  branche réelle du worktree et `agentId` son agent (`pr.number`, `pr.expectedAuthor`), puis de `issue.trace.pr` d'une
  issue dont `trace.agents` contient l'agent (Q5, seul le numéro compte). Lecture par `GhClient.prView(n)` (008
  `contracts/gh.md`), une fois par ouverture de la vue et par numéro. Contrôles : `author.login` = compte de
  l'utilisateur (`gh api user`), `isCrossRepository` faux, `headRefName` = branche réelle. Un contrôle qui échoue → la
  PR n'est pas liée, rien n'est affiché d'elle ; `gh` absent, non connecté ou hors ligne → « PR inconnue ».
- Jamais `pr list`, `search`, ni lecture par nom de branche (US2 sc.5) ; aucun titre, corps ou commentaire : la vue
  n'affiche que `#<n>` et l'état (`ouverte`, `fusionnée`, `fermée`).
- **Avant 008** : `GhClient` n'existe pas encore. Phases 3 à 5 : le numéro noté (`issue.trace.pr`) est affiché, l'état
  vaut « PR inconnue » partout, et rien n'est sûr. La Phase 6 branche `GhClient`.
- **Rationale** : FR-015 et 008 FR-030 ; aucun appel nouveau à `gh`.

## R14 — Verdict « sûr » de « Nettoyer » (FR-014, FR-015, FR-017, US4)

- **Decision** : 008 `WorktreeCleanup` porte les conditions de FR-034 et FR-035. Phase 6 en extrait une fonction de
  lecture `evaluate(worktree, delivery)` → `{ safe: true } | { safe: false, reason }`, sans effet, appelée par le
  nettoyage automatique de 008 et par « Nettoyer ». 011 n'ajoute qu'une condition : l'empreinte de R10, relue avant la
  suppression.
- Dev : PR suivie `MERGED`, `HEAD` = `headRefOid`, `status` vide, aucun ignoré `.env*`, agent fermé. Testeur : mêmes
  conditions, sauf « contenu » par le blob de chaque fichier de test dans `headRefOid` (objet local, sans `fetch` ;
  un objet absent → non sûr). Orchestrateur : jamais. Ancienne version (aucune demande, aucune trace) : jamais.
- Jamais `branch --merged` ni `merge-base --is-ancestor` (FR-015, US4 sc.4) ; test témoin qui parcourt
  `src/main/storage/` à la recherche de ces chaînes.
- La liste « Nettoyer » est une sélection préremplie de la vue : la confirmation de R9 s'affiche, puis un seul
  « Supprimer N éléments · <taille> » (SC-006 : ouvrir l'onglet, « Nettoyer », confirmer).

## R15 — Refus et confirmation renforcée (FR-010, Q6, US5 sc.1, 2)

| Cas | Effet |
|---|---|
| Processus de l'agent en cours (`AgentManager.running` a l'id) | refus, « Fermez d'abord <agent> » |
| Orchestrateur à l'arrêt, ou agent ouvert (`state` ≠ `closed`) à l'arrêt | confirmation renforcée : taper le nom du dossier du worktree, liste des fichiers `.pact/` perdus |
| Agent `closed` ou aucun agent | confirmation normale |
| Intégration (002) en cours sur la branche ; livraison non finale (008, Phase 6) | refus, avec la raison |
| Terminal libre dont le `cwd` noté est dans le worktree | refus, « Un terminal est ouvert dans ce dossier » |
| Autre terminal libre ouvert dans le projet | confirmation qui le cite : « 1 terminal libre est ouvert dans ce projet » (O9) |

Dans un lot, un élément refusé est rendu `refused` avec sa raison ; les autres passent. L'élément renforcé exige son
texte tapé dans le lot aussi.

## R16 — Aucun outil d'agent (FR-019, US5 sc.8)

- **Decision** : aucun outil MCP, ni dans `tools.ts`, ni dans `agent-tools.ts`. `storage:*` est un canal IPC du seul
  renderer. Test : la liste des outils des deux serveurs ne contient aucun nom en `storage`, `remove`, `prune`,
  `clean` ; le préchargement n'expose `storage:remove` qu'au renderer, qui ne l'appelle que depuis le bouton de la
  confirmation.

## R17 — Branche distante (FR-013, Q2, US3 sc.8)

- **Decision** : une case décochée par worktree, offerte seulement si la PR liée (R13) est suivie (008), `MERGED`, que
  la branche n'est pas `mainBranch`, et que `refs/remotes/origin/<b>` existe localement. Cochée, la suppression appelle
  `GitService.deleteRemoteBranch` de 008 (bail sur la tête fusionnée). Avant 008 : jamais offerte.

## R18 — Avis de place (FR-020, Q3, Q16, Q17, US4 sc.8, 9, 11)

- **Decision** : `state.json` gagne `storageNotice: { enabled: true, thresholdGb: 5 }` (défaut, de 1 à 500). Après le
  calcul à basse priorité (R3), si le total supprimable sur confirmation dépasse le seuil et que l'avis est actif, un
  avis discret s'affiche : une ligne sur l'accueil, « 6,2 Go supprimables · Voir le stockage », et un point sur le
  bouton « Réglages ». Ni notification système ni toast ; rien n'est supprimé. L'avis disparaît sous le seuil au calcul
  suivant. Réglage dans l'onglet « Stockage ».
- Le total en mémoire n'est jamais écrit (FR-004).

## R19 — Interface (FR-001, US1 sc.6)

- **Decision** : PACT n'a pas encore de réglages globaux. 011 crée `SettingsDialog` (dialogue à onglets, composants
  `dialog.tsx` et `tabs.tsx`), ouvert par un bouton « Réglages » de la barre du haut (accueil et workspace), avec un
  seul onglet « Stockage » (O4). Le compte « N worktrees conservés » de l'accueil devient un bouton qui ouvre ce
  dialogue sur « Stockage », filtré sur ce projet. La mise en page est décrite dans `contracts/ui.md`.

## R20 — Tests

- Dépôts temporaires (`tests/integration/workspace/*`, modèle existant) avec un remote nu ; `userData` temporaire ;
  faux `gh` (`tests/fixtures/fake-cli/fake-gh.mjs`, étendu par 008). Pièges posés par une fixture commune
  `tests/fixtures/storage/traps.ts` : lien symbolique sous `.worktrees/` vers un dossier témoin, worktree enregistré
  hors `.worktrees/`, dossier inconnu de Git sous `.worktrees/`, faux `~/.claude` et `~/.codex` (`HOME` temporaire),
  entrée verrouillée. Chaque test d'action vérifie l'empreinte des pièges avant et après (SC-004).
- E2E us70 à us79 avec le faux CLI et le faux `gh` ; aucune vraie suppression hors des dossiers temporaires.

## Points ouverts (non bloquants, recommandation donnée)

- **O1 — Worktrees de recalage de 008** (`<userData>/deliveries/<id>`) : 008 les crée et les retire, mais un arrêt
  brutal peut en laisser un, comme pour les intégrations. La spec ne les cite pas (FR-011 ne nomme que
  `integrations`). **Recommandation** : ajouter à FR-011 « ou de `<userData>/deliveries` », mêmes règles qu'un reste
  d'intégration. En attendant, le plan les liste en lecture seule.
- **O2 — `<tmp>/pact-index-*`** : l'inventaire dit « non listés, sauf restes », mais FR-002 ne les range pas parmi les
  supprimables. **Recommandation** : les lister en lecture seule (quelques Ko) ; les rendre supprimables seulement si
  l'utilisateur le demande.
- **O3 — Lien symbolique à un chemin d'inventaire** : US5 sc.7 demande que la cible reste intacte. Deux lectures :
  retirer le lien seul, ou ne rien faire. **Recommandation** : ne rien supprimer, afficher l'élément en lecture seule
  avec « lien symbolique » ; c'est le choix le plus sûr et il satisfait le scénario.
- **O4 — Réglages globaux à un seul onglet** : aucun réglage global n'existe. **Recommandation** : créer le dialogue
  avec le seul onglet « Stockage » ; les seuils de 005 et l'arrêt de 009 pourront y migrer plus tard, hors de 011.
- **O5 — Branche locale sans worktree** : l'inventaire la dit supprimable « avec le worktree ou seule », FR-002 ne la
  cite pas. **Recommandation** : 011 la supprime seulement avec son worktree ; une branche `agent/*` sans worktree est
  listée en lecture seule (elle ne pèse rien). Rejoint 008 P3 (branche du testeur gardée).
- **O6 — Mesure de SC-001** : si l'e2e de 6 Go synthétiques dépasse 1 s pour l'affichage, déplacer `sizer.ts` dans un
  `utilityProcess`. **Recommandation** : commencer dans le processus principal (R3), mesurer en Phase 3.
- **O7 — Seuil de l'avis** : bornes non dites par la spec. **Recommandation** : 1 à 500 Go, entier.
- **O9 — Terminal libre déplacé par `cd`** : PACT note le `cwd` d'un terminal libre à son ouverture (`free-terminals.ts`), pas après un `cd`. L'Edge Case veut que la vérification arrête la suppression. **Recommandation** : refuser si le `cwd` noté est dans le worktree ; sinon citer les terminaux libres ouverts du projet dans la confirmation. Sous Windows, un dossier tenu fait échouer `worktree remove`, et l'échec est rendu. Lire le `cwd` réel (`lsof` sous macOS) ajouterait une commande système : seulement si l'utilisateur le demande.
- **O8 — Chiffres de SC-001 et SC-006** : la spec les dit « à confirmer à la relecture ». Le plan les garde tels quels.
