# Feature Specification: Socle — workspaces, agents et terminaux

**Feature Branch**: `001-agent-workspace-core`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Application de bureau (macOS et Windows) pour piloter plusieurs agents
de code en CLI (Claude Code, Codex, autres) et des terminaux, par dépôt Git. Premier lot (socle) :
Workspaces et projets, Lancement d'agents, Vue Tuiles, Terminal libre, Colonne À faire, Focus sur
un agent (onglet Terminal). Les blocs Comparaison/Aperçus, Revue/Intégration, Workflows,
Notifications et Réglages avancés feront l'objet de specs séparées."

## Périmètre

**Inclus dans cette spec (socle)** : onglets workspaces + accueil, détection et ajout de CLI,
lancement d'agents (mode rapide et détaillé), choix initial des autorisations, isolation par agent
(worktree, branche, port, couleur), vue Tuiles, terminal libre, colonne À faire (réponses et
consignes), Focus sur un agent (onglet Terminal et sélecteur de pastilles), indicateur ◆ sur les
onglets inactifs.

**Hors périmètre (specs ultérieures)** :

- Aperçus et comparaison A/B (onglet Aperçu, bouton Aperçu, diagnostic du serveur d'aperçu).
- Revue et intégration (diff, commentaires, colonne Décision, squash, résolution de conflits,
  bouton Revue, onglet Changements).
- Workflows (bibliothèque, création IA, exécution, onglet Workflow). Dans le socle, le choix de
  workflow au lancement propose uniquement « Aucun ».
- Notifications système et badge sur l'icône de l'application.
- Fenêtre Réglages complète (skills, raccourcis clavier personnalisables, portée projet/globale).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ouvrir un dépôt comme workspace (Priority: P1)

L'utilisateur ouvre l'application, arrive sur l'onglet d'accueil et ouvre un dépôt Git : soit en
glissant-déposant un dossier, soit en choisissant un projet récent, soit en clonant depuis une URL.
Le dépôt s'ouvre dans un nouvel onglet (workspace). Il peut ouvrir plusieurs dépôts, chacun dans son
onglet, et rouvrir l'accueil avec « + ».

**Why this priority**: sans workspace, aucun agent ni terminal ne peut être lancé. C'est le point
d'entrée de toute l'application.

**Independent Test**: ouvrir un dossier Git par glisser-déposer et vérifier qu'un onglet portant le
nom du dépôt apparaît ; cloner une URL publique et vérifier que le dépôt cloné s'ouvre ; fermer puis
rouvrir l'application et retrouver le dépôt dans les projets récents.

**Acceptance Scenarios**:

1. **Given** l'onglet d'accueil ouvert, **When** l'utilisateur dépose un dossier qui est un dépôt Git,
   **Then** un nouvel onglet workspace s'ouvre sur ce dépôt et devient actif.
2. **Given** l'onglet d'accueil ouvert, **When** l'utilisateur saisit une URL de dépôt valide et un
   dossier de destination puis lance le clonage, **Then** la progression est visible et le dépôt
   s'ouvre en workspace à la fin du clonage.
3. **Given** un dépôt déjà ouvert en workspace, **When** l'utilisateur tente de l'ouvrir à nouveau,
   **Then** l'application bascule sur l'onglet existant au lieu d'en créer un second.
4. **Given** des workspaces ouverts, **When** l'utilisateur clique sur « + », **Then** l'onglet
   d'accueil s'ouvre et liste les workspaces ouverts et les projets récents.
5. **Given** l'utilisateur dépose un dossier qui n'est pas un dépôt Git, **When** le dépôt est
   refusé, **Then** un message explique pourquoi et propose d'initialiser un dépôt dans ce dossier.

---

### User Story 2 - Lancer des agents en mode rapide (Priority: P1)

Dans un workspace, l'utilisateur choisit combien d'agents lancer pour chaque CLI détecté (par
exemple 2 Claude Code et 1 Codex), s'il veut un terminal libre, puis lance. Chaque agent démarre
dans son propre worktree, sur sa propre branche, avec son propre port et une couleur attribuée
automatiquement. Au tout premier lancement, l'application demande le niveau d'autorisation par
défaut.

**Why this priority**: c'est la valeur centrale de l'application : faire travailler plusieurs
agents en parallèle sans qu'ils se marchent dessus.

**Independent Test**: lancer 3 agents en mode rapide sur un dépôt de test et vérifier que 3
worktrees, 3 branches distinctes et 3 ports distincts existent, que chaque CLI tourne dans son
worktree et que les couleurs sont attribuées dans l'ordre de création.

**Acceptance Scenarios**:

1. **Given** un workspace ouvert et aucun choix d'autorisation enregistré, **When** l'utilisateur
   lance ses premiers agents, **Then** l'application lui demande de choisir entre « toujours
   autoriser », « demander pour les actions sensibles » et « toujours demander », et mémorise ce choix.
2. **Given** au moins un CLI détecté, **When** l'utilisateur choisit 2 agents d'un CLI et 1 d'un
   autre puis lance, **Then** 3 agents démarrent, chacun avec un worktree, une branche et un port
   uniques.
3. **Given** des agents lancés, **When** l'utilisateur regarde leurs ports, **Then** le port de
   l'agent en position N vaut 3000 + N.
4. **Given** des agents lancés, **When** ils sont affichés, **Then** chacun a une couleur distincte
   attribuée dans l'ordre de création.
5. **Given** l'option « terminal libre » cochée, **When** l'utilisateur lance, **Then** un terminal
   s'ouvre sur le dépôt principal en plus des agents.
6. **Given** un workspace qui compte déjà 6 agents, **When** l'utilisateur tente d'en lancer
   d'autres, **Then** le lancement est refusé avec un message indiquant la limite.

---

### User Story 3 - Piloter les agents depuis la vue Tuiles (Priority: P1)

Les agents s'affichent en grille (2×2 jusqu'à 4 agents, 3×2 pour 5 ou 6). Chaque tuile montre le
CLI brut de l'agent : l'utilisateur tape sa consigne directement dans le terminal de la tuile. La
bordure porte la couleur de l'agent, pulse à chaque changement d'état et affiche un halo rouge fixe
en cas d'erreur. Des boutons en bas à droite permettent d'autoriser/refuser une demande et de
reprendre/relancer l'agent.

**Why this priority**: sans la vue Tuiles, les agents lancés ne sont pas utilisables.

**Independent Test**: lancer 4 agents, vérifier la grille 2×2, taper une consigne dans une tuile et
voir le CLI la recevoir ; provoquer une demande d'autorisation et y répondre via les boutons ;
tuer le processus d'un agent et vérifier le halo rouge et le bouton Relancer.

**Acceptance Scenarios**:

1. **Given** 1 à 4 agents, **When** la vue Tuiles s'affiche, **Then** les tuiles sont disposées en
   grille 2×2 ; **Given** 5 ou 6 agents, **Then** en grille 3×2.
2. **Given** une tuile, **When** l'utilisateur clique dedans et tape du texte, **Then** le texte est
   transmis au CLI de l'agent comme dans un terminal classique (couleurs, raccourcis, curseur).
3. **Given** une tuile, **When** l'utilisateur survole l'icône ⎇, **Then** le nom de la branche de
   l'agent s'affiche.
4. **Given** un agent qui change d'état (travaille → attend une réponse, par exemple), **When** le
   changement survient, **Then** la bordure de sa tuile pulse une fois.
5. **Given** un agent dont le processus s'est terminé en erreur, **When** l'erreur est détectée,
   **Then** la tuile affiche un halo rouge fixe et propose « Relancer ».
6. **Given** un agent qui demande une autorisation, **When** l'utilisateur clique « Autoriser » ou
   « Refuser », **Then** la réponse est transmise à l'agent et la demande disparaît.
7. **Given** le terminal libre ouvert, **When** l'utilisateur y tape une commande, **Then** elle
   s'exécute à la racine du dépôt principal.

---

### User Story 4 - Traiter les demandes depuis la colonne À faire (Priority: P2)

Une colonne À faire liste les actions en attente de tous les agents du workspace, dans l'ordre
recommandé (répondre, puis donner une consigne). Elle propose les mêmes boutons que les tuiles ;
répondre d'un côté fait disparaître l'élément de l'autre. La colonne peut être fermée ; un badge
compte alors les éléments en attente. Un ◆ sur un onglet de workspace inactif signale qu'un agent
de ce workspace attend une réponse.

**Why this priority**: avec plusieurs agents, l'utilisateur doit savoir immédiatement qui l'attend
sans surveiller chaque tuile. Utile dès 2 agents, mais le socle reste utilisable sans.

**Independent Test**: faire en sorte que 2 agents attendent une réponse, vérifier qu'ils
apparaissent dans À faire dans le bon ordre, répondre à l'un depuis la colonne et vérifier qu'il
disparaît aussi de sa tuile ; fermer la colonne et vérifier le badge ; changer d'onglet et
vérifier le ◆.

**Acceptance Scenarios**:

1. **Given** plusieurs agents en attente, **When** la colonne À faire est ouverte, **Then** les
   éléments « répondre » apparaissent avant les éléments « donner une consigne ».
2. **Given** un élément présent dans À faire et sur une tuile, **When** l'utilisateur y répond
   depuis l'un des deux, **Then** il disparaît des deux en moins d'une seconde.
3. **Given** la colonne fermée et 3 éléments en attente, **When** l'utilisateur regarde l'interface,
   **Then** un badge affiche « 3 ».
4. **Given** deux workspaces ouverts et un agent du workspace inactif qui attend une réponse,
   **When** l'utilisateur regarde les onglets, **Then** l'onglet inactif affiche un ◆, qui disparaît
   quand plus aucun agent de ce workspace n'attend.

---

### User Story 5 - Focus sur un agent (Priority: P2)

L'utilisateur agrandit une tuile en vue Focus pour travailler confortablement avec un seul agent.
Un sélecteur de pastilles colorées permet de passer d'un agent à l'autre sans revenir à la grille.
Dans le socle, seul l'onglet Terminal est actif ; les onglets Aperçu, Changements et Workflow
apparaissent comme bientôt disponibles.

**Why this priority**: améliore le confort mais la vue Tuiles suffit pour un usage minimal.

**Independent Test**: ouvrir le Focus sur un agent, taper dans son terminal, passer à un autre
agent via les pastilles, revenir à la grille et vérifier qu'aucune sortie n'a été perdue.

**Acceptance Scenarios**:

1. **Given** la vue Tuiles, **When** l'utilisateur ouvre le Focus d'une tuile, **Then** la tuile
   occupe la zone principale avec son terminal interactif.
2. **Given** le Focus ouvert, **When** l'utilisateur clique la pastille d'un autre agent, **Then**
   le Focus affiche cet agent, avec l'historique complet de son terminal.
3. **Given** le Focus ouvert, **When** l'utilisateur revient à la grille, **Then** tous les agents
   ont continué à tourner et leur sortie est intacte.

---

### User Story 6 - Lancement détaillé et gestion des CLI (Priority: P3)

L'utilisateur configure finement ses agents : réglages communs à tous (permissions, branche de
base) et réglages par agent (CLI, modèle, permissions, branche de base, nom de branche, port et
commande de démarrage). Depuis l'accueil, il voit les CLI détectés sur la machine et peut en ajouter
d'autres en indiquant leur commande.

**Why this priority**: le mode rapide couvre la majorité des usages ; le mode détaillé sert aux
cas avancés.

**Independent Test**: en mode détaillé, lancer 2 agents avec des modèles et des noms de branche
différents, un port personnalisé, et vérifier que chaque agent démarre avec ces réglages ; ajouter
un CLI personnalisé et le voir proposé au lancement.

**Acceptance Scenarios**:

1. **Given** le mode détaillé, **When** l'utilisateur modifie un réglage commun, **Then** il
   s'applique à tous les agents qui n'ont pas de valeur propre pour ce réglage.
2. **Given** un réglage propre à un agent, **When** l'agent est lancé, **Then** ce réglage prime sur
   le réglage commun.
3. **Given** deux agents configurés avec le même nom de branche ou le même port, **When**
   l'utilisateur tente de lancer, **Then** le conflit est signalé et le lancement bloqué.
4. **Given** l'accueil, **When** l'utilisateur ajoute un CLI en donnant un nom et une commande,
   **Then** ce CLI apparaît dans la liste et devient sélectionnable au lancement.
5. **Given** un CLI ajouté dont la commande est introuvable, **When** l'utilisateur l'enregistre,
   **Then** un avertissement indique que la commande n'a pas été trouvée.

---

### Edge Cases

- Aucun CLI détecté : l'accueil l'indique et explique comment en installer ou en ajouter un ; le
  lancement d'agents est désactivé.
- Un port 3000 + N est déjà occupé par un autre programme : l'agent reçoit le premier port libre
  suivant et l'interface l'affiche.
- Une branche du nom prévu existe déjà : un suffixe est ajouté pour garantir l'unicité, sans
  écraser la branche existante.
- Le dépôt a des modifications non commitées : les worktrees partent de la branche de base
  commitée ; l'utilisateur est averti que ses modifications locales ne sont pas incluses.
- Le clonage échoue (URL invalide, accès refusé, réseau) : message clair, aucun onglet vide créé.
- Le dossier d'un workspace est supprimé ou déplacé pendant que l'app tourne : le workspace est
  marqué indisponible et ses agents arrêtés proprement.
- Un agent est fermé : l'utilisateur choisit de conserver ou de supprimer son worktree et sa branche.
- Fermeture de l'application avec des agents actifs : confirmation demandée ; au redémarrage,
  les workspaces et leurs agents (worktrees, branches, couleurs, ports) sont restaurés et chaque
  agent peut être repris.
- Chemins avec espaces ou caractères accentués (par exemple « Développement ») : fonctionnent sur
  macOS et Windows.

## Requirements *(mandatory)*

### Functional Requirements

**Plateformes**

- **FR-001**: L'application MUST fonctionner sur macOS et sur Windows avec les mêmes fonctionnalités.

**Workspaces et accueil**

- **FR-002**: Le système MUST afficher un onglet par dépôt Git ouvert (workspace) et un onglet
  d'accueil ouvert par « + ».
- **FR-003**: L'accueil MUST lister les workspaces ouverts et les projets récents, et permettre
  d'ouvrir un dépôt par glisser-déposer d'un dossier ou par clonage depuis une URL.
- **FR-004**: Le système MUST empêcher l'ouverture d'un même dépôt dans deux onglets.
- **FR-005**: Le système MUST mémoriser les projets récents et les workspaces ouverts entre deux
  sessions.

**CLI**

- **FR-006**: Le système MUST détecter automatiquement les CLI d'agents installés, au minimum
  Claude Code et Codex.
- **FR-007**: Les utilisateurs MUST pouvoir ajouter un CLI en indiquant un nom et une commande de
  lancement.

**Lancement d'agents**

- **FR-008**: Le mode rapide MUST permettre de choisir un nombre d'agents par CLI, l'ouverture d'un
  terminal libre et un workflow (limité à « Aucun » dans ce socle), puis de lancer.
- **FR-009**: Le mode détaillé MUST permettre de définir des réglages communs et, par agent : CLI,
  modèle, permissions, branche de base, nom de branche, port et commande de démarrage.
- **FR-010**: Au premier lancement d'agents, le système MUST demander le niveau d'autorisation par
  défaut parmi : toujours autoriser, demander pour les actions sensibles, toujours demander ; et
  MUST mémoriser ce choix.
- **FR-011**: Chaque agent MUST disposer de son propre worktree et de sa propre branche, créés à
  partir de la branche de base choisie.
- **FR-012**: Chaque agent MUST recevoir le port 3000 + sa position (1 à 6), ou le premier port
  libre suivant si ce port est occupé.
- **FR-013**: Chaque agent MUST recevoir automatiquement une couleur distincte, dans l'ordre de
  création.
- **FR-014**: Le système MUST limiter le nombre d'agents simultanés à 6 par workspace.

**Vue Tuiles et terminaux**

- **FR-015**: La vue Tuiles MUST disposer les agents en grille 2×2 jusqu'à 4 agents et 3×2 pour 5 ou 6.
- **FR-016**: Chaque tuile MUST afficher le CLI brut de l'agent dans un terminal interactif
  complet (saisie, couleurs, raccourcis) ; la consigne se tape directement dedans.
- **FR-017**: La bordure de chaque tuile MUST porter la couleur de l'agent ; l'icône ⎇ MUST
  afficher la branche au survol.
- **FR-018**: Le système MUST distinguer au minimum les états d'agent : en cours, attend une
  réponse, inactif (prêt pour une consigne), terminé, en erreur.
- **FR-019**: Chaque changement d'état MUST déclencher un pulse de bordure ; l'état erreur MUST
  afficher un halo rouge fixe jusqu'à relance ou fermeture.
- **FR-020**: Chaque tuile MUST proposer, selon l'état, les actions Autoriser / Refuser et
  Reprendre / Relancer. Les actions Revue et Aperçu sont réservées aux specs ultérieures.
- **FR-021**: Le système MUST proposer un terminal libre ouvert à la racine du dépôt principal.
- **FR-022**: Les agents MUST continuer à s'exécuter quelle que soit la vue affichée (grille,
  Focus, autre onglet).

**Colonne À faire**

- **FR-023**: La colonne À faire MUST lister les actions en attente de tous les agents du
  workspace, triées dans l'ordre : répondre, puis donner une consigne.
- **FR-024**: Chaque élément MUST proposer les mêmes boutons que la tuile correspondante ; une
  réponse donnée d'un côté MUST retirer l'élément des deux côtés.
- **FR-025**: La colonne MUST pouvoir être fermée ; un badge MUST alors compter les éléments en
  attente.
- **FR-026**: Un onglet de workspace inactif MUST afficher un ◆ tant qu'au moins un de ses agents
  attend une réponse.

**Focus**

- **FR-027**: Le système MUST permettre d'afficher un agent en grand (Focus) avec son terminal
  interactif, et de revenir à la grille.
- **FR-028**: Le Focus MUST proposer un sélecteur de pastilles aux couleurs des agents pour passer
  d'un agent à l'autre.
- **FR-029**: Le Focus MUST afficher les onglets Terminal, Aperçu, Changements et Workflow ; seul
  Terminal est actif dans ce socle.

**Cycle de vie**

- **FR-030**: À la fermeture d'un agent, le système MUST demander s'il faut conserver ou supprimer
  son worktree et sa branche.
- **FR-031**: Au redémarrage de l'application, le système MUST restaurer les workspaces et leurs
  agents (worktree, branche, port, couleur) et permettre de reprendre chaque agent.
- **FR-032**: Le système MUST ne jamais modifier la branche principale du dépôt lors du lancement
  ou de la fermeture d'agents.

### Key Entities

- **Workspace** : un dépôt Git ouvert dans un onglet. Chemin, nom, branche principale, liste
  d'agents, terminal libre éventuel, date de dernière ouverture.
- **Projet récent** : référence à un dépôt déjà ouvert (chemin, nom, date), affichée à l'accueil.
- **CLI d'agent** : outil en ligne de commande pilotable (nom, commande, détecté ou ajouté,
  disponible ou non, modèles proposés si connus).
- **Agent** : instance d'un CLI dans un workspace. Position, couleur, CLI, modèle, niveau de
  permissions, branche de base, branche, worktree, port, commande de démarrage, état.
- **Terminal** : session interactive rattachée à un agent (dans son worktree) ou libre (à la
  racine du dépôt), avec son historique de sortie.
- **Élément À faire** : action en attente liée à un agent (type : répondre ou donner une consigne,
  date, statut traité ou non).
- **Préférence d'autorisation** : niveau choisi au premier lancement (toujours autoriser,
  demander pour les actions sensibles, toujours demander).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un nouvel utilisateur ouvre un dépôt et lance 3 agents en mode rapide en moins de
  2 minutes, sans documentation.
- **SC-002**: 6 agents actifs en parallèle dans un workspace restent utilisables : la saisie dans
  n'importe quelle tuile s'affiche sans délai perceptible (moins de 100 ms).
- **SC-003**: Un agent qui passe en attente de réponse apparaît dans À faire (et ◆ sur l'onglet si
  inactif) en moins de 2 secondes dans 95 % des cas.
- **SC-004**: 100 % des agents lancés ont un worktree, une branche et un port distincts ; aucune
  modification d'un agent n'apparaît dans le worktree d'un autre ni sur la branche principale.
- **SC-005**: Après fermeture et réouverture de l'application, 100 % des workspaces et agents sont
  restaurés avec la même couleur, la même branche et le même port.
- **SC-006**: L'ensemble des scénarios d'acceptation passe à l'identique sur macOS et sur Windows.
- **SC-007**: En usage avec 4 agents, l'utilisateur n'a jamais besoin de parcourir les tuiles pour
  savoir qui l'attend : 90 % des réponses aux agents sont données via À faire ou via un indicateur
  (◆, pulse) plutôt qu'en inspectant chaque terminal.

## Assumptions

- Les CLI d'agents (Claude Code, Codex…) sont installés et authentifiés par l'utilisateur en dehors
  de l'application ; l'application les lance et les affiche mais ne gère pas leurs comptes.
- Git est installé sur la machine ; le clonage utilise les identifiants Git déjà configurés.
- La position d'un agent va de 1 à 6 ; le port 3000 reste libre pour l'application du dépôt
  principal. Ports résultants : 3001 à 3006.
- Le niveau d'autorisation choisi est traduit vers le mode de permissions propre à chaque CLI ;
  pour un CLI qui ne supporte pas un niveau, le niveau le plus prudent disponible s'applique.
- Les états d'un agent (attend une réponse, en erreur, etc.) sont déduits de son processus et de
  sa sortie terminal ; la précision peut varier selon le CLI.
- Les worktrees sont créés dans un dossier dédié hors du dépôt principal, pour ne pas le polluer.
- Usage mono-utilisateur, en local ; pas de compte, pas de synchronisation entre machines.
- Le choix « Aucun » est le seul workflow disponible tant que la spec Workflows n'est pas livrée.
- Le choix d'autorisation initial est global ; il sera modifiable via la future fenêtre Réglages.
