# Feature Specification: Gestionnaire de stockage

**Feature Branch**: `007-010-specs`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "Une interface globale de PACT pour voir et supprimer au besoin les worktrees et les autres
éléments stockés. Vue globale, tous projets confondus, puis par projet, avec la taille de chaque élément et le total
récupérable. Le calcul des tailles ne bloque pas l'interface et n'écrit rien. Pour chaque worktree : projet, branche, agent
rattaché et son état, PR liée et son état, fichiers modifiés, commits non poussés, date du dernier changement. Suppression à
l'unité ou en lot, avec une confirmation qui dit exactement ce qui sera perdu, irrécupérable ou non. Action « Nettoyer » : liste
les éléments sûrs avec les mêmes critères que 008 (PR fusionnée, commit de tête identique ou contenu, propre) et la place gagnée.
Un agent actif, ou le worktree de l'orchestrateur, ne se supprime pas sans refus explicite ou confirmation renforcée. PACT ne
supprime que ce qu'il a créé, vérifié par chemin. Il ne touche pas aux données des CLI (~/.claude, ~/.codex) ni au dépôt principal.
Le squash interdit de détecter une fusion par ascendance avec main ; une PR d'un autre auteur que l'utilisateur est ignorée, jamais
lue ni récupérée."

## Contexte

Mesuré le 2026-11-05 sur le dépôt PACT : 13 dossiers dans `.worktrees/` pour 6,4 Go, environ 750 Mo par worktree, surtout
`node_modules`. Tout le reste de ce que PACT écrit dans ses données d'application pèse 28 Mo, dont 18 Mo de cache Chromium : la place
se gagne sur les worktrees, le reste demande surtout de la prudence. Aujourd'hui, l'accueil n'affiche qu'un compte de « worktrees
conservés » (`workspace/workspace-service.ts:39`, `renderer/home/Home.tsx:181`), et supprimer un worktree n'est possible qu'à la
fermeture de son agent.

### Inventaire de ce que PACT stocke

`<userData>` est le dossier de données d'application (`index.ts:72`).

| Élément | Où | Source | Vie actuelle | Suppression |
| ------- | -- | ------ | ------------ | ----------- |
| Worktree d'agent | `<dépôt>/.worktrees/<cli>-<position>[-n]`, exclu par `/.worktrees/` dans `info/exclude` | `git/git-service.ts:16`, `:113-136` | Reste à la fermeture, sauf demande de l'utilisateur | Élément principal |
| Branche locale d'agent | `agent/<cli>-<position>[-n]`, ou branche choisie ou renommée par l'agent | `git-service.ts:135`, `agents/agent-manager.ts:458` | Part avec son worktree (`branch -D`) | Avec le worktree ou seule |
| Entrée Git de worktree | `<dépôt>/.git/worktrees/<nom>` | `git-service.ts:155`, `:453` | `git worktree prune` seulement sur certains chemins | Entrées mortes seulement |
| Worktree temporaire d'intégration | `<userData>/integrations/<id>`, détaché | `index.ts:298`, `review/integration-service.ts:206` | Retiré après usage ; rien au démarrage, donc un arrêt brutal peut en laisser un | Si aucune intégration n'est en cours |
| Copies de conflit | `<userData>/conflicts/<id>/…` | `index.ts:299`, `integration-service.ts:304` | Effacées à chaque démarrage (`index.ts:329`) ; 008 FR-025 changera ce point | Si aucun conflit n'est en cours |
| Skills et plugin de rôle | `<userData>/roles/<agentId>/` | `index.ts:120`, `orchestrator/plugin.ts`, `orchestrator/role-skills.ts` | Retirés à la libération de l'agent (`orchestrator-service.ts:150`) ; 5 dossiers, 80 Ko | Orphelins seulement |
| Fichier de rôle d'un CLI générique | `<worktree>/.pact/ROLE.md`, exclu de Git | `role-skills.ts:23`, `agent-manager.ts:746` | Retiré à la fermeture | Avec le worktree |
| Issues et maquettes | `<worktree>/.pact/issues/`, `<worktree>/.pact/`, `<worktree>/design/mockups/` | `orchestrator/issues.ts:11`, `preview/preview-service.ts:49-53` | Vivent dans le worktree, souvent non suivies ; l'aperçu ne copie rien | Perdues avec le worktree : à dire |
| Données d'un workspace | `<userData>/workspaces/<hash>.json` (agents, issues, boucles, réglages) | `persistence/store.ts:122-138` | Jamais retirées, même pour un projet oublié | Si le projet n'est ni ouvert ni récent ; ses issues et réglages partent, à dire |
| État de l'application | `<userData>/state.json` (récents, CLI ajoutés, permissions, seuils) | `store.ts:125` | Permanent | Jamais |
| Sauvegardes et temporaires du stockage | `<fichier>.corrupt-<date>`, `<fichier>.<pid>.<n>.tmp` | `store.ts:79-87` | Sauvegarde gardée sans limite | `.corrupt-*` et `.tmp`, sur confirmation |
| Caches d'Electron | `<userData>/Cache`, `Code Cache`, `GPUCache`, `GraphiteDawnCache`, etc. | Chromium | Gérés par Chromium | Oui, avec relance demandée |
| Branche distante d'agent | Sur le remote : celle d'une PR suivie | 008 FR-043 | Supprimée à la fusion si sa tête est le commit fusionné ; sinon reste | Case décochée, PR suivie et fusionnée seulement (FR-013) |
| Index temporaires | `<tmp>/pact-index-<uuid>` | `git-service.ts:211`, `:397` | Retirés après usage | Non listés, sauf restes |

**Sans stockage disque aujourd'hui** : journal d'un agent (`pty/pty-manager.ts:118`), journal d'actions de l'orchestrateur
(`orchestrator-service.ts:51`), lectures de consommation (`usage/usage-service.ts`), file d'événements : tout est en mémoire. À venir : 007 gardera le journal des messages dans les données du workspace (500 par workspace) et un fichier d'événements exclu de Git dans le worktree des CLI sans MCP, 010 un `.pact/workflow.yaml` versionné : les deux premiers partent avec leur élément, à dire ; le dernier est du code du projet, jamais supprimé ici.

**Hors de portée, jamais touché** : dépôt principal et son `.git`, en dehors des entrées mortes ; `~/.claude` et `~/.codex`, que PACT lit
seulement (`agents/hook-bridge.ts:53`, `agents/agent-manager.ts:834`, `usage/codex-rollout.ts`).

**Un cas réel à ne pas confondre** : ce dépôt enregistre aussi un worktree créé par un autre outil, sous
`~/.claude/jobs/…/tmp/pact-main`. `git worktree list` ne prouve donc pas que PACT l'a créé.

## Références UI

Pas de maquette dédiée : à produire au plan. L'accueil affiche déjà le compte de worktrees conservés. Libellés :
`docs/maquettes/CONSIGNES-UI.md`.

## Dépendances

- **Prérequis** : 001 (workspaces, worktrees), 008 (critères d'un élément sûr : FR-034 à FR-036 ; PR suivies et leur numéro).
- **À faire après 008**. Les vues et la suppression à l'unité ne dépendent pas de 008, l'action « Nettoyer » si.

## Périmètre

**Inclus** : une interface globale, tous projets confondus puis par projet ; la taille de chaque élément, le total récupérable et le total supprimable sur confirmation ; le détail
de chaque worktree ; la suppression à l'unité ou en lot ; l'action « Nettoyer » ; le retrait des entrées Git mortes.

**Hors périmètre** :

- Les données des CLI (`~/.claude`, `~/.codex`), et le dépôt principal.
- Toute PR d'un autre auteur.
- Le nettoyage automatique à la fusion (008).
- Le ménage dans `.git` (objets, `git gc`), et les dépôts que PACT n'a jamais ouverts.

## Clarifications

### Session 2026-11-05

Décisions données par l'utilisateur avec la demande, à ne pas rouvrir :

- Q: Quelle vue ? → A: une interface globale, tous projets confondus, puis par projet, avec la taille de chaque élément et le total
  récupérable.
- Q: Comment calculer ? → A: sans bloquer l'interface, et sans rien écrire.
- Q: Que montrer pour un worktree ? → A: projet, branche, agent rattaché et son état, PR liée et son état, fichiers modifiés, commits non
  poussés, date du dernier changement.
- Q: Comment supprimer ? → A: à l'unité ou en lot, avec une confirmation qui dit exactement ce qui sera perdu, irrécupérable ou non.
- Q: Que fait « Nettoyer » ? → A: liste les éléments sûrs avec les mêmes critères que 008 (PR fusionnée, commit de tête identique ou
  contenu, propre) et la place gagnée.
- Q: Que peut-on supprimer ? → A: seulement ce que PACT a créé, vérifié par chemin. Ni les données des CLI, ni le dépôt principal.
- Q: Comment détecter une fusion ? → A: jamais par l'ascendance avec main, à cause du squash. Une PR d'un autre auteur que l'utilisateur est
  ignorée, jamais lue ni récupérée.

Décisions de l'utilisateur sur les propositions, le 2026-11-05 :

- Q1: Où placer l'interface ? → A: un onglet « Stockage » dans les réglages globaux, ouvert aussi depuis le compte de worktrees de l'accueil, qui filtre alors sur ce projet.
- Q2: PACT supprime-t-il les branches distantes ? → A: jamais par défaut ; une case par élément, décochée, seulement pour la branche d'une PR suivie et fusionnée, jamais `main` ni une branche d'une PR ouverte. Elle complète 008 FR-043.
- Q3: Une alerte de place disque ? → A: un avis discret quand les worktrees récupérables dépassent 5 Go, réglable ou coupable ; aucune suppression ne s'ensuit. Le disque plein n'est pas surveillé. (Précisé par Q16 et Q17.)
- Q4: Un nettoyage périodique ? → A: non. 008 nettoie déjà à la fusion ; « Nettoyer » reste un geste de l'utilisateur.
- Q5: Les worktrees d'une ancienne version ? → A: listés, jamais comme sûrs, avec ce qui serait perdu et l'état « PR inconnue », et supprimables à l'unité ou en lot, sur confirmation. `issue.trace` peut relier certains d'entre eux à une PR ; seul le numéro noté compte, avec les contrôles de FR-015.
- Q6: Refus ou confirmation renforcée ? → A: agent dont le processus tourne : refus, il faut d'abord le fermer. Orchestrateur et agent ouvert à l'arrêt : confirmation renforcée, qui fait taper le nom du worktree et liste les fichiers `.pact/` perdus.
- Q7: « Vérifié par chemin » suffit-il ? → A: un élément est de PACT si son chemin résolu est un enfant direct de `<dépôt>/.worktrees/`, ou de `<userData>/integrations`, et que Git le connaît comme worktree de ce dépôt ; tout le reste est affiché en lecture seule, ou pas du tout. (Précisé par Q15.)
- Q8: Quels éléments hors worktrees ? → A: caches d'Electron, oui, avec relance demandée ; rôles orphelins, restes d'intégration et de conflit, oui ; sauvegardes `.corrupt-*`, oui, sur confirmation ; données d'un workspace, seulement si le projet n'est ni ouvert ni récent, en disant que ses issues et réglages
  partent ; `state.json`, jamais. (Précisé par Q15.)
- Q9: Quels projets ? → A: tous ceux qui ont un fichier dans `workspaces/`, même fermés ; un projet déplacé ou absent est affiché avec ses données, sans ses worktrees, qui ne sont pas calculables.
- Q10: La date du dernier changement ? → A: la plus récente entre le dernier commit de la branche et la modification d'un fichier suivi ou non suivi, hors fichiers ignorés.
- Q11: Un fichier ignoré est-il « perdu » à dire ? → A: la confirmation donne leur taille totale et cite ceux qui correspondent à `.env*`, mêmes règles que 008 FR-034.
- Q12: Un lot qui échoue en partie ? → A: les éléments passent un à un, sans arrêt au premier échec ; le résultat liste les réussites et les échecs avec leur raison.
- Q13: Sans `gh` ou sans réseau ? → A: « PR inconnue » ; l'élément n'est pas sûr, mais reste supprimable à la main.
- Q14: « Irrécupérable » ? → A: un commit absent de toute branche distante, un fichier modifié ou non suivi, sont dits irrécupérables ; un commit présent sur une branche distante est récupérable.
- Q15: Q7 laisse-t-elle supprimer les éléments de Q8 ? → A: Q7 vaut pour les worktrees ; les éléments de Q8 sont de PACT si leur chemin résolu est celui de l'inventaire, sous `<userData>`, un reste d'intégration y compris ; un `.tmp` se traite comme une sauvegarde.
- Q16: Comment l'avis connaît-il la taille ? → A: un calcul à basse priorité au démarrage et après une fusion, seule exception à FR-003, sans rien écrire ; « récupérable » désigne les éléments sûrs de « Nettoyer ».
- Q17: Le total récupérable doit-il rester presque toujours à zéro ? → A: la définition de « récupérable » reste (éléments sûrs). Un second total s'y ajoute, « supprimable sur confirmation », et l'avis à 5 Go porte sur ce second total.

## Questions ouvertes

Aucune.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Voir ce qui occupe la place (Priority: P1)

L'utilisateur ouvre le stockage : il voit le total, tous projets confondus, ce qui est récupérable, ce qui est supprimable sur confirmation, puis le détail par projet. L'interface répond
aussitôt, et les tailles se remplissent au fil du calcul.

**Why this priority**: on ne supprime rien sans voir, et cette vue ne présente aucun risque.

**Independent Test**: dépôts Git temporaires avec des worktrees de tailles connues ; ouvrir la vue, comparer les totaux, et vérifier que le dépôt et les
fichiers sont inchangés après le calcul.

**Acceptance Scenarios**:

1. **Given** deux projets avec des worktrees, **When** l'utilisateur ouvre la vue globale, **Then** il voit le total, le total récupérable, le total supprimable sur confirmation et une ligne par projet.
2. **Given** une ligne de projet, **When** il l'ouvre, **Then** il voit chaque élément et sa taille.
3. **Given** un calcul en cours sur plusieurs Go, **When** l'utilisateur agit dans PACT, **Then** l'interface reste réactive, et les tailles non encore
   connues sont indiquées comme telles.
4. **Given** un calcul terminé, **When** on compare le disque, le `.git` et son index avant et après, **Then** rien n'a été écrit.
5. **Given** un projet fermé ou absent du disque, **When** la vue s'affiche, **Then** un projet fermé est affiché, et un projet absent montre ses données, sans ses worktrees, qui ne sont pas calculables.
6. **Given** le compte de worktrees de l'accueil, **When** l'utilisateur le suit, **Then** l'onglet « Stockage » des réglages globaux s'ouvre, filtré sur ce projet.

---

### User Story 2 - Comprendre un worktree avant d'y toucher (Priority: P1)

Pour un worktree, l'utilisateur lit projet, branche, agent et état, PR et état, fichiers modifiés, commits non poussés et date du dernier changement.

**Why this priority**: c'est cette information qui évite une suppression à tort.

**Independent Test**: faux `gh` et dépôts temporaires qui couvrent chaque état ; lire la ligne affichée.

**Acceptance Scenarios**:

1. **Given** un worktree, **When** l'utilisateur l'ouvre, **Then** il voit les sept informations demandées, avec pour date la plus récente entre le dernier commit et la modification d'un fichier non ignoré.
2. **Given** un worktree sans agent, **When** il s'affiche, **Then** il dit « aucun agent », sans erreur.
3. **Given** un worktree avec une PR notée, **When** l'état est lu, **Then** il vient du numéro noté, avec l'auteur et le dépôt source vérifiés.
4. **Given** `gh` absent ou hors ligne, **When** l'état est lu, **Then** l'état affiché est « PR inconnue » ; l'élément n'est pas sûr, mais reste supprimable à la main.
5. **Given** une PR d'un autre auteur sur une branche de même nom, **When** la vue s'affiche, **Then** elle n'est ni lue, ni affichée, ni liée.
6. **Given** un commit non poussé, **When** l'état s'affiche, **Then** il est calculé sur les références distantes déjà connues, sans `fetch`, et l'écran dit que cet état peut être en retard.

---

### User Story 3 - Supprimer en sachant ce qui part (Priority: P1)

L'utilisateur sélectionne un ou plusieurs éléments. La confirmation dit exactement ce qui sera perdu, irrécupérable ou non.

**Why this priority**: c'est l'objet de la spec, et l'action la plus risquée.

**Independent Test**: dépôts temporaires avec fichier modifié, fichier non suivi et commit non poussé ; lire la confirmation, confirmer, comparer le disque.

**Acceptance Scenarios**:

1. **Given** un worktree avec un fichier modifié et un commit non poussé, **When** l'utilisateur demande la suppression, **Then** la confirmation nomme ce fichier et ce commit, et les dit irrécupérables ; un commit présent sur une branche distante est dit récupérable.
2. **Given** cette confirmation, **When** il annule, **Then** rien ne change.
3. **Given** plusieurs éléments sélectionnés, **When** il confirme, **Then** chacun est traité, sans arrêt au premier échec, et le résultat liste les réussites et les échecs avec leur raison.
4. **Given** un état changé depuis la confirmation (nouveau fichier, agent relancé), **When** la suppression part, **Then** l'élément est retenu, et l'utilisateur doit
   confirmer de nouveau.
5. **Given** un worktree avec des maquettes ou des issues non suivies, **When** la confirmation s'affiche, **Then** elle les cite.
6. **Given** une entrée Git morte, **When** l'utilisateur la retire, **Then** seules les entrées mortes du dépôt partent, par `git worktree prune`.
7. **Given** un worktree avec des fichiers ignorés dont un `.env`, **When** la confirmation s'affiche, **Then** elle donne leur taille totale et cite ce `.env`.
8. **Given** une PR suivie et fusionnée dont la branche distante existe encore, **When** la confirmation s'affiche, **Then** une case décochée la propose ; **Given** `main` ou une branche de PR ouverte, ou une branche sans PR suivie, **Then** aucune case n'est offerte.

---

### User Story 4 - Nettoyer en une action (Priority: P2)

L'utilisateur lance « Nettoyer » : PACT liste ce qui est sûr selon les critères de 008, et la place gagnée.

**Why this priority**: le gain le plus rapide, mais il dépend des critères de 008.

**Independent Test**: faux `gh` avec PR suivies fusionnées, non fusionnées ou tierces, et worktrees propres ou non ; vérifier la liste.

**Acceptance Scenarios**:

1. **Given** une PR suivie fusionnée et un worktree de dev identique au commit de tête et propre, **When** l'utilisateur lance « Nettoyer », **Then** il y figure avec sa taille.
2. **Given** un worktree de testeur contenu dans le commit fusionné et propre, **When** il lance « Nettoyer », **Then** il y figure.
3. **Given** un worktree avec un fichier modifié ou un commit de plus, **When** il lance « Nettoyer », **Then** il n'y figure pas.
4. **Given** une branche dont tous les commits sont dans `main`, sans PR fusionnée notée, **When** il lance « Nettoyer », **Then** elle n'est pas dite sûre : l'ascendance ne prouve rien.
5. **Given** une PR fusionnée avec squash, **When** il lance « Nettoyer », **Then** la détection réussit par la PR et son commit de tête.
6. **Given** la liste, **When** il l'ouvre, **Then** rien n'est supprimé sans confirmation, et la place totale gagnée est indiquée.
7. **Given** un worktree d'une ancienne version, **When** il lance « Nettoyer », **Then** il n'est pas dit sûr ; dans la vue, il est listé avec ce qui serait perdu et l'état « PR inconnue », et se supprime sur confirmation.
8. **Given** PACT qui démarre, ou une fusion constatée, **When** le total supprimable sur confirmation dépasse 5 Go, **Then** un avis discret paraît, sans vue ouverte, sans rien écrire ni supprimer.
9. **Given** 6 Go de worktrees d'une ancienne version, **When** la vue s'affiche, **Then** ils comptent dans le total supprimable sur confirmation, pas dans le total récupérable, et l'avis paraît.
10. **Given** PACT ouvert longtemps, **When** aucun geste n'a lieu, **Then** rien n'est nettoyé de lui-même.
11. **Given** un seuil réglé à 10 Go, ou l'avis coupé, **When** le total supprimable sur confirmation atteint 6 Go, **Then** aucun avis ne paraît.

---

### User Story 5 - Ce qui ne se supprime pas (Priority: P1)

Un agent actif et l'orchestrateur sont protégés ; un dossier que PACT n'a pas créé, le dépôt principal et les données des CLI sont hors d'atteinte.

**Why this priority**: une seule erreur ici détruit du travail en cours ou des données d'un autre outil.

**Independent Test**: placer des éléments piégés (lien symbolique sortant, worktree externe, faux dossier sous `.worktrees/`) dans un dépôt temporaire, et vérifier qu'ils restent après toute action.

**Acceptance Scenarios**:

1. **Given** un agent actif, **When** l'utilisateur demande de supprimer son worktree, **Then** PACT refuse si son processus tourne : il faut d'abord le fermer.
2. **Given** le worktree de l'orchestrateur, **When** l'utilisateur demande sa suppression, **Then** PACT refuse si son processus tourne ; à l'arrêt, comme pour un agent ouvert à l'arrêt, la confirmation renforcée fait taper le nom du worktree et liste les fichiers `.pact/` perdus. Il ne figure jamais dans « Nettoyer ».
3. **Given** un worktree enregistré par Git hors de `.worktrees/` (un outil externe), **When** la vue s'affiche, **Then** il n'est pas supprimable.
4. **Given** un lien symbolique sous `.worktrees/` qui pointe ailleurs, **When** une suppression le vise, **Then** la cible reste intacte, car son chemin résolu n'est pas un enfant direct de `.worktrees/`.
5. **Given** `~/.claude`, `~/.codex` et le dépôt principal, **When** toute action a lieu, **Then** ils ne changent pas.
6. **Given** un dossier sous `.worktrees/` que Git ne connaît pas comme worktree de ce dépôt, **When** la vue s'affiche, **Then** il n'est pas supprimable.
7. **Given** un reste sous `<userData>/integrations` retiré de Git, un cache, une sauvegarde ou un `.tmp` à son chemin d'inventaire, **When** l'utilisateur le supprime, **Then** PACT le retire ; **Given** un lien symbolique à ce chemin qui pointe ailleurs, **Then** la cible reste intacte.
8. **Given** un agent, **When** il cherche à déclencher une suppression, **Then** aucun de ses outils ne le permet.
9. **Given** `state.json`, un élément en lecture seule ou le worktree d'un agent dont le processus tourne, **When** les totaux se calculent, **Then** ils ne comptent pas dans le total supprimable sur confirmation.
10. **Given** les données d'un workspace, **When** la vue s'affiche, **Then** elles sont supprimables seulement si le projet n'est ni ouvert ni récent ; **Given** un cache d'Electron supprimé, **Then** PACT demande une relance ; **Given** un rôle orphelin, **Then** il est supprimable sur confirmation.

### Edge Cases

- Un agent démarre pendant la confirmation, ou un terminal libre est ouvert dans le worktree : la vérification faite juste avant la suppression l'arrête.
- Sous Windows, un fichier reste verrouillé : l'échec est dit, sans retrait forcé en boucle.
- `removeWorktree` existant force le retrait et fait `branch -D` (`git-service.ts:144-158`) : la suppression passe d'abord par les contrôles de cette spec.
- Un worktree sur un disque débranché : son dossier manque, et `git worktree prune` retirerait son entrée. *Une entrée verrouillée reste*, et l'interface présente l'entrée avant de la retirer.
- Une branche locale liée à deux chemins, ou renommée par son agent : c'est la branche réelle du worktree qui compte, pas celle enregistrée.
- Une intégration ou une livraison (008) est en cours sur l'élément : refus, avec la raison.
- Deux fenêtres ou actions simultanées sur le même élément : la seconde constate qu'il n'existe plus, sans erreur bloquante.
- Une grosse arborescence (`node_modules`) : le calcul reste interruptible à la fermeture de la vue.
- Des liens durs (partage entre `node_modules`) : la place gagnée est une estimation, et la vue le dit.
- Une erreur de lecture d'un seul élément n'empêche pas d'afficher les autres.
- La branche du projet principal (`main`) n'est jamais supprimée, même si un worktree y est rattaché.
- Une branche distante cochée dans la même suppression ne compte plus : un commit qui n'est que sur elle est dit irrécupérable.
- Un commit de sauvegarde de 009 n'existe qu'en local : il compte comme un commit non poussé, irrécupérable, et rend le worktree non sûr.

## Requirements *(mandatory)*

### Functional Requirements

**Vues**

- **FR-001**: PACT MUST offrir une interface globale du stockage, tous projets confondus puis par projet : un onglet « Stockage » dans les réglages globaux, ouvert aussi depuis le compte de worktrees de l'accueil, qui filtre alors sur ce projet. Elle MUST couvrir tous les projets qui ont un fichier dans
  `workspaces/`, même fermés ; un projet déplacé ou absent est affiché avec ses données, sans ses worktrees.
- **FR-002**: La vue MUST montrer la taille de chaque élément et, pour l'inventaire de cette spec, deux totaux : « récupérable », les éléments sûrs de « Nettoyer », et « supprimable sur confirmation », tout ce que l'utilisateur peut supprimer, sans ce que FR-010 refuse ni ce qui est en lecture seule. Hors worktrees, sont supprimables
  les caches d'Electron, avec relance demandée, les rôles orphelins, les restes d'intégration et de conflit, les sauvegardes `.corrupt-*` et `.tmp` sur confirmation, et les données d'un workspace dont le projet n'est ni ouvert ni récent. `state.json` ne l'est jamais.
- **FR-003**: Le calcul des tailles MUST ne pas bloquer l'interface, afficher ce qui est connu au fur et à mesure, et s'arrêter quand on ne le regarde plus. Seule exception : un calcul à basse priorité au démarrage de PACT et après une fusion, sans rien écrire, pour l'avis de FR-020.
- **FR-004**: Le calcul et la lecture des états MUST ne rien écrire : ni fichier, ni référence, ni index Git (les commandes Git de lecture ne doivent pas
  rafraîchir l'index), et aucun `fetch`.
- **FR-005**: Pour chaque worktree, PACT MUST montrer projet, branche, agent rattaché et son état, PR liée et son état, fichiers modifiés, commits non poussés, date du dernier changement : la plus récente entre le dernier commit de la branche et la modification d'un fichier suivi ou non suivi, hors fichiers ignorés.
  Sans `gh` ou sans réseau, l'état est « PR inconnue » : l'élément n'est pas sûr, mais reste supprimable à la main.
- **FR-006**: Les commits non poussés MUST se calculer sur les références distantes déjà connues, et l'écran MUST préciser que cet état peut être en retard sur le remote.

**Suppression**

- **FR-007**: PACT MUST permettre de supprimer à l'unité ou en lot. Un lot passe élément par élément, sans arrêt au premier échec, et le résultat liste les réussites et les échecs avec leur raison.
- **FR-008**: Avant toute suppression, la confirmation MUST dire exactement ce qui sera perdu : fichiers modifiés et non suivis, commits non poussés, maquettes et issues non suivies, fichiers ignorés (leur taille totale, et ceux qui correspondent à `.env*`), et si c'est irrécupérable. Un commit absent de toute branche
  distante, un fichier modifié ou non suivi, sont irrécupérables ; un commit présent sur une branche distante est récupérable.
- **FR-009**: L'état MUST être relu juste avant la suppression : s'il diffère de ce qui a été confirmé, rien n'est supprimé pour cet élément.
- **FR-010**: Un agent dont le processus tourne MUST faire refuser la suppression : il faut d'abord le fermer. L'orchestrateur et un agent ouvert à l'arrêt MUST exiger une confirmation renforcée, qui fait taper le nom du worktree et liste les fichiers `.pact/` perdus.
- **FR-011**: PACT MUST ne supprimer que ce qu'il a créé, vérifié par chemin résolu : un worktree est de PACT si ce chemin est un enfant direct de `<dépôt>/.worktrees/`, ou de `<userData>/integrations`, et que Git le connaît comme worktree de ce dépôt ; un élément hors worktrees, un reste d'intégration y compris, si ce chemin est celui de l'inventaire, sous
  `<userData>`. Le reste est en lecture seule, ou absent.
- **FR-012**: PACT MUST ne jamais modifier `~/.claude`, `~/.codex` ni le dépôt principal, hors entrées mortes de `git worktree prune`. La branche principale MUST ne jamais être supprimée.
- **FR-013**: PACT MUST ne jamais supprimer une branche distante par défaut : une case par élément, décochée, seulement pour la branche d'une PR suivie et fusionnée, jamais `main` ni une branche d'une PR ouverte. Elle complète 008 FR-043.

**Nettoyer**

- **FR-014**: « Nettoyer » MUST lister les seuls éléments sûrs selon 008 (PR suivie et fusionnée, commit de tête identique ou contenu, propre, au sens de 008 FR-034 et FR-035) avec la place gagnée, et ne rien supprimer sans confirmation.
- **FR-015**: Toute détection de fusion MUST passer par une PR au numéro noté, dont l'auteur est le compte de l'utilisateur et le dépôt source ce dépôt. Elle MUST ne jamais se fonder sur
  `git branch --merged` ni sur l'ascendance avec main.
- **FR-016**: Une PR d'un autre auteur que l'utilisateur MUST être ignorée, jamais lue ni récupérée, et aucun texte écrit par un tiers ne MUST s'afficher dans cette interface.
- **FR-017**: Les worktrees d'une ancienne version MUST être listés, jamais comme sûrs, avec ce qui serait perdu et l'état « PR inconnue », et se supprimer à l'unité ou en lot, sur confirmation. `issue.trace` peut les relier à une PR ; seul le numéro noté compte, avec les contrôles de FR-015.
- **FR-018**: PACT MUST permettre de retirer les entrées Git mortes par `git worktree prune`, après les avoir montrées.
- **FR-019**: Aucun outil d'agent MUST ne pouvoir déclencher ces suppressions : ce sont des gestes de l'utilisateur.

**Avis**

- **FR-020**: Un avis discret MUST paraître quand le total supprimable sur confirmation dépasse 5 Go, seuil réglable, avis coupable, et ne jamais supprimer. Sa taille vient du calcul à basse priorité de FR-003, gardée en mémoire. Le disque plein n'est pas surveillé.
- **FR-021**: PACT MUST ne faire aucun nettoyage périodique : 008 nettoie à la fusion, et « Nettoyer » reste un geste de l'utilisateur.

### Key Entities

- **Élément stocké** : type, chemin, projet, taille (connue ou non), récupérable ou non, supprimable sur confirmation ou non, créé par PACT ou non.
- **Worktree** : projet, branche réelle, agent et état, PR notée et état, fichiers modifiés, commits non poussés, date du dernier changement, verdict sûr ou non.
- **Perte annoncée** : fichiers, commits, fichiers ignorés, caractère irrécupérable, état relu.
- **Résultat de suppression** : élément, réussite ou échec, raison.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: La vue s'affiche en moins de 1 s, avant la fin du calcul des tailles, même avec 6 Go de worktrees.
- **SC-002**: Sur tous les scénarios de test, le calcul ne change aucun fichier, aucune référence ni index Git.
- **SC-003**: Aucune suppression ne perd un élément que la confirmation n'a pas annoncé.
- **SC-004**: Aucun élément piégé (lien symbolique, worktree externe, dossier inconnu, données d'un CLI, dépôt principal) n'est modifié dans aucun scénario.
- **SC-005**: « Nettoyer » ne désigne jamais comme sûr un élément sans PR fusionnée notée, ni une PR d'un autre auteur.
- **SC-006**: Un utilisateur récupère la place des worktrees sûrs en moins de 3 gestes, à la souris comme au clavier.

## Assumptions

- Les tailles se calculent sur le disque, sans cache persistant.
- La disposition suit `docs/maquettes/CONSIGNES-UI.md`, au clavier et au lecteur d'écran, sur macOS et Windows.
- Les durées et les gestes des critères de succès sont des propositions de l'agent spec, à confirmer à la relecture.
- Les chiffres du contexte ont été mesurés sur la machine de l'utilisateur le 2026-11-05 : ils ne sont pas des limites.
- Les tests utilisent des dépôts temporaires et un faux `gh` : aucun worktree réel n'est supprimé.
