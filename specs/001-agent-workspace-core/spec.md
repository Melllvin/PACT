# Feature Specification: Socle — workspaces, agents et terminaux

**Feature Branch**: `001-agent-workspace-core`

**Created**: 2026-09-23

**Status**: Draft (révisée d'après les maquettes hi-fi, 2026-09-23)

**Input**: User description: "Application de bureau (macOS et Windows) pour piloter plusieurs agents
de code en CLI (Claude Code, Codex, autres) et des terminaux, par dépôt Git. Premier lot (socle) :
Workspaces et projets, Lancement d'agents, Vue Tuiles, Terminal libre, Colonne À faire, Focus sur
un agent (onglet Terminal). Les blocs Comparaison/Aperçus, Revue/Intégration, Workflows,
Notifications et Réglages avancés feront l'objet de specs séparées."

## Références UI

Source de vérité visuelle : `docs/maquettes/Maquettes hi-fi.dc.html` (direction 1c), complétée par
`docs/maquettes/Direction retenue.dc.html` (palette, typographie) et
`docs/maquettes/Grille reactive.dc.html` (animations). Écrans couverts par ce socle : 1a, 1b, 1c,
1d, 1m, 1e, 1f, 1l, 1n, 1p. Consigne de rédaction des libellés : `docs/maquettes/CONSIGNES-UI.md`.

**Amendement du 2026-09-25** : l'apparence (palette, typographie, formes, effets) suit désormais
`docs/maquettes/Maquette interactive.dc.html` (research.md R17). La direction 1c reste la
référence pour la structure des écrans et les libellés ; les vues et réglages que seule la maquette
interactive montre (Comparer, Revue, Réglages, Workflows, notifications, raccourcis clavier) restent
hors de cette spec.

## Périmètre

**Inclus dans cette spec (socle)** : onglets workspaces + accueil, détection et ajout de CLI,
lancement d'agents (mode rapide et détaillé), choix initial des autorisations, isolation par agent
(worktree, branche, port, couleur), vue Tuiles, terminal libre, colonne À faire (réponses et
consignes), Focus sur un agent (onglet Terminal et sélecteur de pastilles), indicateurs ◆ / ✕ sur
les onglets inactifs, reprise après limite de débit.

**Hors périmètre (specs ultérieures)** :

- Aperçus et comparaison A/B (vue Comparer, onglet et bouton Aperçu, diagnostic du serveur
  d'aperçu, écrans 1g, 1i, 1j, 1o).
- Revue et intégration (vue Revue, diff, commentaires, colonne Décision, squash, conflits, onglet
  Changements, bouton Revue, écrans 1h, 1q).
- Workflows (bibliothèque, création IA, exécution, onglet Workflow, écrans 1t, 1u, 1v). Dans le
  socle, le sélecteur de workflow propose uniquement « Libre » (consigne dans le CLI, rien d'autre).
- Skills (bibliothèque, sélection par agent, écran 1s).
- Notifications système et badge sur l'icône de l'application (écran 1r).
- Fenêtre Réglages complète, raccourcis clavier personnalisables (écran 1k).
- Bouton « Copier la consigne ⤵ » visible sur l'écran 1e.
- Plus de 6 agents par workspace.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ouvrir un dépôt comme workspace (Priority: P1)

L'utilisateur ouvre l'application et arrive sur l'onglet d'accueil (écran 1a). Il y voit les
workspaces déjà ouverts (chemin, branche, nombre de worktrees, pastilles de couleur des agents,
nombre d'agents en attente), les projets récents (branche, worktrees conservés, date de dernière
ouverture), une zone pour déposer un dossier ou choisir un dépôt, un bouton pour cloner depuis une
URL, et la liste des CLI d'agents détectés. Il ouvre un dépôt, qui apparaît dans un nouvel onglet.
Un workspace neuf est vide : une seule action « + Ajouter des agents » (écran 1b).

**Why this priority**: sans workspace, aucun agent ni terminal ne peut être lancé. C'est le point
d'entrée de toute l'application.

**Independent Test**: ouvrir un dossier Git par glisser-déposer et vérifier qu'un onglet portant le
nom du dépôt apparaît avec l'état vide ; cloner une URL et vérifier que le dépôt cloné s'ouvre ;
fermer puis rouvrir l'application et retrouver le dépôt dans les projets récents.

**Acceptance Scenarios**:

1. **Given** l'onglet d'accueil ouvert, **When** l'utilisateur dépose un dossier qui est un dépôt Git
   ou le choisit via « Choisir un dépôt Git… », **Then** un nouvel onglet workspace s'ouvre sur ce
   dépôt et devient actif.
2. **Given** l'onglet d'accueil ouvert, **When** l'utilisateur saisit une URL de dépôt et un dossier
   de destination puis lance le clonage, **Then** la progression est visible et le dépôt s'ouvre en
   workspace à la fin du clonage.
3. **Given** un dépôt déjà ouvert en workspace, **When** l'utilisateur tente de l'ouvrir à nouveau,
   **Then** l'application bascule sur l'onglet existant (« Aller à l'onglet ») au lieu d'en créer un
   second.
4. **Given** des workspaces ouverts, **When** l'utilisateur clique sur « + » dans la barre
   d'onglets, **Then** l'onglet d'accueil s'ouvre ; il peut filtrer les projets avec « Rechercher… ».
5. **Given** l'utilisateur dépose un dossier qui n'est pas un dépôt Git, **When** le dépôt est
   refusé, **Then** un message explique pourquoi et propose d'initialiser un dépôt dans ce dossier.
6. **Given** un workspace neuf, **When** il s'affiche, **Then** la zone principale ne propose qu'une
   action « + Ajouter des agents » ; la colonne À faire est absente ; les vues Comparer et Revue sont
   grisées.

---

### User Story 2 - Lancer des agents en mode rapide (Priority: P1)

Dans un workspace, l'utilisateur ouvre le menu d'ajout (« + » central ou « + Agents », écran 1c),
règle des compteurs « − n + » pour chaque CLI détecté, pour « Autre CLI » et pour « Terminal libre »,
puis clique « Lancer N agents ». Tout le reste prend des valeurs par défaut (worktree depuis la
branche principale, port automatique). Au tout premier lancement, l'application demande le niveau
d'autorisation (écran 1m). Chaque agent démarre dans son worktree, sur sa branche provisoire, avec
son port et sa couleur. Les CLI attendent alors une consigne (écran 1e).

**Why this priority**: c'est la valeur centrale de l'application : faire travailler plusieurs
agents en parallèle sans qu'ils se marchent dessus.

**Independent Test**: lancer 3 agents en mode rapide sur un dépôt de test et vérifier que 3
worktrees, 3 branches distinctes et 3 ports distincts existent, que chaque CLI tourne dans son
worktree, que les couleurs suivent l'ordre de la palette, et que 3 éléments « Donner une consigne »
apparaissent dans À faire.

**Acceptance Scenarios**:

1. **Given** aucun choix d'autorisation enregistré, **When** l'utilisateur clique « Lancer »,
   **Then** l'application affiche une fois le choix entre « Toujours autoriser » (présélectionné),
   « Demander pour les actions sensibles » et « Toujours demander », avec la portée « Ce projet » ou
   « Tous les projets », ainsi que l'option « Reprendre automatiquement après une limite de débit »
   (activée) ; la touche Entrée valide les choix par défaut et lance.
2. **Given** au moins un CLI détecté, **When** l'utilisateur règle 2 Claude Code et 1 Codex puis
   lance, **Then** 3 agents démarrent, chacun avec un worktree, une branche et un port uniques.
3. **Given** des agents lancés, **When** l'utilisateur regarde leurs ports, **Then** le port de
   l'agent en position N vaut 3000 + N.
4. **Given** des agents lancés, **When** ils sont affichés, **Then** leurs couleurs suivent l'ordre
   Purple, Cyan, Green, Magenta, Yellow, Slate.
5. **Given** le compteur « Terminal libre » à 1, **When** l'utilisateur lance, **Then** un terminal
   s'ouvre sur le dépôt principal en plus des agents.
6. **Given** des agents qui viennent de démarrer, **When** l'utilisateur regarde À faire, **Then**
   un élément « Donner une consigne · <CLI> · tapez dans le terminal » existe pour chaque agent, et
   aucun travail ne commence tant qu'aucune consigne n'est tapée.
7. **Given** un workspace dans lequel l'utilisateur a déjà lancé des agents, **When** il rouvre le
   menu d'ajout, **Then** les compteurs reprennent les dernières valeurs utilisées dans ce workspace.
8. **Given** un workspace qui compte déjà 6 agents, **When** l'utilisateur tente d'en lancer
   d'autres, **Then** le lancement est refusé avec un message indiquant la limite.

---

### User Story 3 - Piloter les agents depuis la vue Tuiles (Priority: P1)

Les agents s'affichent en grille (2×2 jusqu'à 4 agents, 3×2 pour 5 ou 6 ; écrans 1f, 1l). Une
tuile n'a ni numéro, ni titre, ni état affiché : elle montre le CLI brut, et la consigne se tape
directement dans son invite. La bordure porte la couleur de l'agent, pulse à chaque changement
d'état et affiche un halo rouge fixe en cas d'erreur (écran 1n). Les actions apparaissent en bas à
droite selon l'état : Autoriser / Refuser, ou Journal / Relancer / Reprendre après une erreur.

**Why this priority**: sans la vue Tuiles, les agents lancés ne sont pas utilisables.

**Independent Test**: lancer 4 agents, vérifier la grille 2×2, taper une consigne dans une tuile et
voir le CLI la recevoir ; provoquer une demande d'autorisation et y répondre via les boutons ;
tuer le processus d'un agent et vérifier le halo rouge et les actions Reprendre / Relancer.

**Acceptance Scenarios**:

1. **Given** 1 à 4 agents, **When** la vue Tuiles s'affiche, **Then** les tuiles sont disposées en
   grille 2×2 et chaque emplacement libre affiche un « + » qui ouvre le menu d'ajout ; **Given** 5 ou
   6 agents, **Then** en grille 3×2, sans changement de couleur des agents existants.
2. **Given** une tuile, **When** l'utilisateur clique dedans et tape du texte, **Then** le texte est
   transmis au CLI de l'agent comme dans un terminal classique (couleurs, raccourcis, curseur).
3. **Given** une tuile, **When** l'utilisateur survole l'icône ⎇, **Then** la branche actuelle de
   l'agent et son port s'affichent ; si l'agent a renommé sa branche, c'est le nouveau nom qui
   s'affiche.
4. **Given** un agent qui change d'état, **When** le changement survient, **Then** la bordure de sa
   tuile pulse une fois.
5. **Given** un agent qui demande une autorisation, **When** l'utilisateur clique « ✓ Autoriser » ou
   « ✕ Refuser », **Then** la réponse est transmise au CLI et les boutons disparaissent.
6. **Given** un agent dont le processus s'est arrêté en erreur, **When** l'erreur est détectée,
   **Then** la tuile affiche un halo rouge fixe, la sortie brute reste visible, et les actions
   « Journal », « Relancer » (repart de la consigne initiale) et « Reprendre » (reprend la même
   session) sont proposées.
7. **Given** le terminal libre ouvert, **When** l'utilisateur y tape une commande, **Then** elle
   s'exécute à la racine du dépôt principal ; il apparaît dans À faire comme « En cours ▸ <shell> —
   <branche> ».

---

### User Story 4 - Traiter les demandes depuis la colonne À faire (Priority: P2)

Une colonne À faire liste les actions en attente de tous les agents du workspace, dans l'ordre
recommandé (répondre, puis donner une consigne). Elle propose les mêmes boutons que les tuiles ;
répondre d'un côté fait disparaître l'élément de l'autre. La colonne peut être fermée : son bouton
passe en clair et garde son badge. Un onglet de workspace inactif affiche ◆ si un agent attend, ✕
si un agent est en erreur (◆ prioritaire sur ✕).

**Why this priority**: avec plusieurs agents, l'utilisateur doit savoir immédiatement qui l'attend
sans surveiller chaque tuile. Utile dès 2 agents, mais le socle reste utilisable sans.

**Independent Test**: faire en sorte que 2 agents attendent une réponse, vérifier qu'ils
apparaissent dans À faire dans le bon ordre, répondre à l'un depuis la colonne et vérifier qu'il
disparaît aussi de sa tuile ; fermer la colonne et vérifier le badge ; changer d'onglet et
vérifier ◆ puis ✕.

**Acceptance Scenarios**:

1. **Given** plusieurs agents en attente, **When** la colonne À faire est ouverte, **Then** les
   éléments « ◆ Répondre » apparaissent avant les éléments « Donner une consigne », chacun repérable
   par la couleur de son agent.
2. **Given** un élément présent dans À faire et sur une tuile, **When** l'utilisateur y répond
   depuis l'un des deux, **Then** il disparaît des deux en moins d'une seconde.
3. **Given** la colonne fermée et 3 éléments en attente, **When** l'utilisateur regarde la barre
   d'outils, **Then** le bouton À faire est affiché en clair avec un badge « 3 ».
4. **Given** deux workspaces ouverts et un agent du workspace inactif qui attend une réponse,
   **When** l'utilisateur regarde les onglets, **Then** l'onglet inactif affiche ◆ ; si aucun agent
   n'attend mais qu'un agent est en erreur, il affiche ✕ ; sinon aucun indicateur.
5. **Given** aucun élément en attente, **When** la colonne est ouverte, **Then** elle affiche
   « Rien à faire · vous serez prévenu ».

---

### User Story 5 - Focus sur un agent (Priority: P2)

L'utilisateur agrandit une tuile avec ⤢ pour travailler confortablement avec un seul agent (écran
1p). Un sélecteur de pastilles colorées permet de passer d'un agent à l'autre sans revenir à la
grille ; « ‹ Tuiles » ou Échap y revient. Dans le socle, seul l'onglet Terminal est actif ; les
onglets Aperçu et Changements sont affichés grisés.

**Why this priority**: améliore le confort mais la vue Tuiles suffit pour un usage minimal.

**Independent Test**: ouvrir le Focus sur un agent, taper dans son terminal, passer à un autre
agent via les pastilles, revenir à la grille avec Échap et vérifier qu'aucune sortie n'a été perdue.

**Acceptance Scenarios**:

1. **Given** la vue Tuiles, **When** l'utilisateur clique ⤢ sur une tuile, **Then** la tuile occupe
   la zone principale avec son terminal interactif, la branche et le port en en-tête.
2. **Given** le Focus ouvert, **When** l'utilisateur clique la pastille d'un autre agent, **Then**
   le Focus affiche cet agent, avec l'historique complet de son terminal.
3. **Given** le Focus ouvert, **When** l'utilisateur clique « ‹ Tuiles » ou appuie sur Échap hors
   du terminal, **Then** la grille revient ; tous les agents ont continué à tourner et leur sortie
   est intacte.
4. **Given** une demande d'autorisation affichée dans le Focus, **When** l'utilisateur choisit
   « Toujours pour ce worktree », **Then** les demandes du même type pour cet agent sont
   automatiquement autorisées jusqu'à sa fermeture.

---

### User Story 6 - Lancement détaillé et gestion des CLI (Priority: P3)

L'utilisateur configure finement ses agents dans un panneau maître-détail (écran 1d) : à gauche
« ⚑ Commun à tous » et la liste des agents (identifiés par leur couleur, réordonnables par
glisser-déposer, ce qui fixe l'ordre des tuiles) ; à droite l'inspecteur de l'élément choisi : CLI,
modèle, permissions (Demander / Auto · worktree / Tout auto), branche de base, branche, port et
commande. Un agent n'affiche en plein que ce qu'il surcharge (≠) ; les valeurs héritées sont en
pointillés. Depuis l'accueil, l'utilisateur ajoute d'autres CLI en indiquant leur commande.

**Why this priority**: le mode rapide couvre la majorité des usages ; le mode détaillé sert aux
cas avancés.

**Independent Test**: en mode détaillé, lancer 2 agents avec des modèles et des noms de branche
différents et un port personnalisé, et vérifier que chaque agent démarre avec ces réglages ;
ajouter un CLI personnalisé et le voir proposé au lancement.

**Acceptance Scenarios**:

1. **Given** le mode rapide avec des compteurs réglés, **When** l'utilisateur clique « Mode
   détaillé… », **Then** le panneau s'ouvre avec les mêmes agents ; « ← Mode rapide » revient sans
   perte.
2. **Given** le mode détaillé, **When** l'utilisateur modifie un réglage de « Commun à tous »,
   **Then** il s'applique à tous les agents qui ne le surchargent pas.
3. **Given** un réglage surchargé sur un agent, **When** l'agent est affiché, **Then** le réglage
   porte la marque ≠ et le compteur ≠ de l'agent augmente ; au lancement, il prime sur le commun.
4. **Given** la liste des agents, **When** l'utilisateur glisse un agent à une autre position,
   **Then** l'ordre des tuiles, des ports et des couleurs suit le nouvel ordre ; « Dupliquer » et
   « Retirer » agissent sur l'agent sélectionné.
5. **Given** deux agents configurés avec le même nom de branche ou le même port, **When**
   l'utilisateur tente de lancer, **Then** le conflit est signalé et le lancement bloqué.
6. **Given** l'accueil, **When** l'utilisateur choisit « Autre CLI — ajouter » et donne un nom et
   une commande, **Then** ce CLI apparaît dans la liste et devient sélectionnable au lancement ; si
   la commande est introuvable, un avertissement l'indique.

---

### User Story 7 - Reprise automatique après limite de débit (Priority: P3)

L'utilisateur décide **en amont**, une seule fois, si les agents reprennent automatiquement
après une limite de débit de leur fournisseur : la question est posée sur l'écran d'autorisations
du premier lancement (1m), avec la même portée (ce projet / tous les projets). Ensuite, quand un
agent est bloqué par une limite, il reprend seul à la levée, sans nouvelle question, même si
l'utilisateur est absent.

**Why this priority**: évite de surveiller les agents bloqués, mais Reprendre manuel couvre déjà le
besoin.

**Independent Test**: activer la reprise automatique au premier lancement ; simuler une limite de
débit avec heure de levée ; vérifier que la tuile affiche « reprise auto à HH:MM · Annuler » et que
la session reprend à l'heure prévue sans action ; désactiver l'option et vérifier que seules les
actions manuelles restent.

**Acceptance Scenarios**:

1. **Given** l'écran d'autorisations du premier lancement, **When** il s'affiche, **Then** il
   propose aussi « Reprendre automatiquement après une limite de débit » (activé par défaut), avec la
   même portée que les autorisations.
2. **Given** la reprise automatique activée et un agent bloqué par une limite, **When** la limite
   est détectée, **Then** la tuile et À faire affichent « reprise auto à HH:MM · Annuler » sans poser
   de question ; **When** l'heure est inconnue, **Then** l'application retente à intervalles
   croissants (au plus toutes les 15 minutes).
3. **Given** une reprise programmée, **When** l'heure arrive, **Then** l'agent reprend la même
   session sans intervention.
4. **Given** une reprise programmée, **When** l'utilisateur clique « Annuler », « Reprendre » ou
   « Relancer », ou ferme l'agent, **Then** la reprise programmée est annulée.
5. **Given** la reprise automatique désactivée, **When** une limite est détectée, **Then** la tuile
   passe en erreur avec les seules actions manuelles.
6. **Given** un CLI qui gère déjà lui-même la reprise après limite, **When** il reprend seul,
   **Then** l'application ne déclenche pas de seconde reprise.

---

### Edge Cases

- Aucun CLI détecté : l'accueil l'indique et explique comment en installer ou en ajouter un ; le
  lancement d'agents est désactivé.
- Un CLI est installé mais pas connecté à son compte : l'agent démarre et le CLI affiche lui-même sa
  demande de connexion dans la tuile.
- Un port 3000 + N est déjà occupé par un autre programme : l'agent reçoit le premier port libre
  suivant et l'infobulle ⎇ l'affiche.
- Une branche du nom prévu existe déjà : un suffixe est ajouté pour garantir l'unicité, sans
  écraser la branche existante.
- Le dépôt a des modifications non commitées : les worktrees partent de la branche de base
  commitée ; l'utilisateur est averti que ses modifications locales ne sont pas incluses.
- Le clonage échoue (URL invalide, accès refusé, réseau) : message clair, aucun onglet vide créé.
- Le dossier d'un workspace est supprimé ou déplacé pendant que l'app tourne : le workspace est
  marqué indisponible et ses agents arrêtés proprement.
- Un agent est fermé : l'utilisateur choisit de conserver ou de supprimer son worktree et sa
  branche ; un worktree conservé est signalé à l'accueil (« 1 worktree conservé »).
- Fermeture de l'application avec des agents actifs : confirmation demandée ; au redémarrage,
  les workspaces et leurs agents (worktrees, branches, couleurs, ports) sont restaurés et chaque
  agent peut être repris.
- Chemins avec espaces ou caractères accentués (par exemple « Développement ») : fonctionnent sur
  macOS et Windows.
- Application lancée depuis le Finder (macOS) ou le menu Démarrer (Windows) : les CLI installés
  dans le PATH du shell de l'utilisateur sont détectés comme depuis un terminal.
- Le dossier `.worktrees/` ne doit pas apparaître comme modification dans le dépôt principal.

## Requirements *(mandatory)*

### Functional Requirements

**Plateformes**

- **FR-001**: L'application MUST fonctionner sur macOS et sur Windows avec les mêmes
  fonctionnalités.

**Workspaces et accueil**

- **FR-002**: Le système MUST afficher un onglet par dépôt Git ouvert (workspace) et un onglet
  d'accueil ouvert par « + ».
- **FR-003**: L'accueil MUST lister les workspaces ouverts (chemin, branche, nombre de worktrees,
  pastilles des agents, nombre d'agents en attente), les projets récents (chemin, branche,
  worktrees conservés, dernière ouverture), permettre la recherche, et permettre d'ouvrir un dépôt
  par glisser-déposer, par sélecteur de dossier ou par clonage depuis une URL.
- **FR-004**: Le système MUST empêcher l'ouverture d'un même dépôt dans deux onglets et renvoyer
  vers l'onglet existant.
- **FR-005**: Le système MUST mémoriser les projets récents et les workspaces ouverts entre deux
  sessions.
- **FR-006**: Un workspace sans agent MUST n'afficher qu'une action « + Ajouter des agents » ; la
  colonne À faire MUST apparaître avec le premier agent ; les vues Comparer et Revue MUST être
  visibles mais inactives dans ce socle.

**CLI**

- **FR-007**: Le système MUST détecter automatiquement les CLI d'agents installés, au minimum
  Claude Code et Codex, y compris quand l'application est lancée hors d'un terminal.
- **FR-008**: Les utilisateurs MUST pouvoir ajouter un CLI en indiquant un nom et une commande de
  lancement.

**Lancement d'agents**

- **FR-009**: Le menu d'ajout rapide MUST proposer un compteur par CLI détecté, un compteur « Autre
  CLI », un compteur « Terminal libre » et un sélecteur de workflow (limité à « Libre »), et un
  bouton « Lancer N agents ».
- **FR-010**: Les compteurs du mode rapide MUST être mémorisés par workspace.
- **FR-011**: Le mode détaillé MUST proposer « Commun à tous » et, par agent : CLI, modèle,
  permissions, branche de base, branche, port et commande ; il MUST signaler les surcharges (≠),
  permettre de réordonner, dupliquer et retirer des agents.
- **FR-012**: Au premier lancement d'agents, le système MUST demander le niveau d'autorisation
  parmi : toujours autoriser (présélectionné), demander pour les actions sensibles (suppression de
  données, réseau, fichiers hors worktree), toujours demander ; avec la portée « Ce projet » ou
  « Tous les projets » ; et MUST mémoriser ce choix. Le libellé de chaque niveau MUST décrire
  fidèlement ce que les agents peuvent faire (pas de promesse de confinement non garantie).
- **FR-013**: Chaque agent MUST disposer de son propre worktree dans `.worktrees/<nom>` à la racine
  du dépôt, et de sa propre branche provisoire (`agent/<cli>-<n>`) créée depuis la branche de base.
- **FR-014**: Le dossier `.worktrees/` MUST être exclu du suivi Git du dépôt sans modifier les
  fichiers versionnés de l'utilisateur.
- **FR-015**: Chaque agent MUST recevoir le port 3000 + sa position (1 à 6), ou le premier port
  libre suivant si ce port est occupé ; ce port MUST être fourni à l'agent.
- **FR-016**: Chaque agent MUST recevoir sa couleur à la création dans l'ordre : Purple, Cyan,
  Green, Magenta, Yellow, Slate. L'orange est réservé à l'état « attend » et le rouge à l'erreur.
- **FR-017**: Le système MUST limiter le nombre d'agents simultanés à 6 par workspace.
- **FR-018**: Après le lancement, le système MUST créer pour chaque agent un élément « Donner une
  consigne » et ne transmettre aucune consigne à sa place.

**Vue Tuiles et terminaux**

- **FR-019**: La vue Tuiles MUST disposer les agents en grille 2×2 jusqu'à 4 agents et 3×2 pour 5
  ou 6 ; les emplacements libres MUST afficher « + ».
- **FR-020**: Chaque tuile MUST afficher le CLI brut de l'agent dans un terminal interactif
  complet, sans surcouche ni effet dans le terminal, et sans numéro, titre ni libellé d'état.
- **FR-021**: La bordure de chaque tuile MUST porter la couleur de l'agent ; l'icône ⎇ MUST
  afficher au survol la branche actuelle du worktree et le port.
- **FR-022**: Le système MUST distinguer au minimum les états d'agent : démarrage, attend une
  consigne, en cours, attend une réponse, terminé, en erreur.
- **FR-023**: Chaque changement d'état MUST déclencher un pulse de bordure ; l'état erreur MUST
  afficher un halo rouge fixe jusqu'à reprise, relance ou fermeture.
- **FR-024**: Chaque tuile MUST proposer en bas à droite, selon l'état : Autoriser / Refuser (attend
  une réponse) ; Journal / Relancer / Reprendre (erreur). « Reprendre » MUST reprendre la même
  session du CLI ; « Relancer » MUST redémarrer le CLI et retaper la consigne initiale.
- **FR-025**: Le système MUST proposer un terminal libre ouvert à la racine du dépôt principal.
- **FR-026**: Les agents MUST continuer à s'exécuter quelle que soit la vue affichée (grille,
  Focus, autre onglet).

**Colonne À faire**

- **FR-027**: La colonne À faire MUST lister les actions en attente de tous les agents du
  workspace, triées dans l'ordre : répondre, puis donner une consigne ; puis les éléments
  informatifs (terminal libre en cours).
- **FR-028**: Chaque élément MUST proposer les mêmes boutons que la tuile correspondante ; une
  réponse donnée d'un côté MUST retirer l'élément des deux côtés.
- **FR-029**: La colonne MUST pouvoir être fermée ; son bouton MUST alors conserver un badge
  comptant les éléments en attente.
- **FR-030**: Un onglet de workspace inactif MUST afficher ◆ tant qu'au moins un agent attend une
  réponse, sinon ✕ tant qu'au moins un agent est en erreur.

**Focus**

- **FR-031**: Le système MUST permettre d'afficher un agent en grand (Focus) via ⤢, et d'en sortir
  via « ‹ Tuiles » ou Échap.
- **FR-032**: Le Focus MUST proposer un sélecteur de pastilles aux couleurs des agents pour passer
  d'un agent à l'autre.
- **FR-033**: Le Focus MUST afficher les onglets Terminal, Aperçu et Changements ; seul Terminal est
  actif dans ce socle.
- **FR-034**: Les demandes d'autorisation MUST proposer « Toujours pour ce worktree », qui autorise
  automatiquement les demandes suivantes du même type pour cet agent.

**Reprise après limite de débit**

- **FR-035**: Le système MUST demander en amont, sur l'écran d'autorisations du premier lancement,
  si la reprise automatique après limite de débit est activée (défaut : oui), avec la portée projet
  ou globale, et MUST mémoriser ce choix.
- **FR-036**: Quand la reprise automatique est activée et qu'une limite est détectée, le système
  MUST programmer sans question la reprise de la même session à l'heure de levée si elle est
  connue, sinon à intervalles croissants plafonnés à 15 minutes, et afficher « reprise auto à
  HH:MM · Annuler » ; toute action manuelle sur l'agent MUST l'annuler ; aucune reprise ne doit
  être déclenchée si le CLI a déjà repris de lui-même.

**Cycle de vie**

- **FR-037**: À la fermeture d'un agent, le système MUST demander s'il faut conserver ou supprimer
  son worktree et sa branche.
- **FR-038**: Au redémarrage de l'application, le système MUST restaurer les workspaces et leurs
  agents (worktree, branche, port, couleur) et permettre de reprendre chaque agent.
- **FR-039**: Le système MUST ne jamais modifier la branche principale du dépôt lors du lancement
  ou de la fermeture d'agents.

**Interface**

- **FR-040**: L'interface MUST suivre la direction 1c : thème sombre, palette de la section
  Références UI, vert = accepter, rouge = refuser / erreur, cyan = action, orange ◆ = attend.
- **FR-041**: Les libellés d'état, badges et statuts MUST rester concis, être remplacés par une
  icône quand c'est possible (◆ attend, ✓ prêt, ✕ erreur), et une légende MUST expliquer chaque
  icône.
- **FR-042**: Les changements de vue MUST s'animer (particules, puis tuiles, puis bordures) et les
  éléments de À faire MUST entrer en se dépliant ; ces animations MUST être désactivées quand le
  système demande de réduire les animations.

### Key Entities

- **Workspace** : un dépôt Git ouvert dans un onglet. Chemin, nom, branche principale, liste
  d'agents ordonnée, terminaux libres, derniers compteurs du mode rapide, date de dernière
  ouverture.
- **Projet récent** : référence à un dépôt déjà ouvert (chemin, nom, branche, worktrees conservés,
  date), affichée à l'accueil.
- **CLI d'agent** : outil en ligne de commande pilotable (nom, commande, détecté ou ajouté,
  disponible ou non, modèles proposés si connus).
- **Agent** : instance d'un CLI dans un workspace. Position, couleur, CLI, modèle, niveau de
  permissions, branche de base, branche, worktree, port, commande, consigne initiale, identifiant
  de session, état.
- **Terminal** : session interactive rattachée à un agent (dans son worktree) ou libre (à la
  racine du dépôt), avec son historique de sortie.
- **Élément À faire** : action en attente liée à un agent (type : répondre ou donner une consigne,
  date, statut traité ou non).
- **Préférence d'autorisation** : niveau choisi (toujours autoriser, demander pour les actions
  sensibles, toujours demander), reprise automatique après limite (oui / non) et portée (projet ou
  tous les projets).
- **Reprise programmée** : agent concerné, heure prévue ou prochaine tentative, numéro d'essai.

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
- **SC-008**: Avec la reprise automatique activée, un agent bloqué par une limite de débit reprend
  sans intervention, utilisateur absent, dans les 5 minutes suivant la levée de la limite.

## Assumptions

- Les CLI d'agents (Claude Code, Codex…) sont installés et authentifiés par l'utilisateur en dehors
  de l'application ; l'accueil indique qu'un CLI est « installé » (pas son état de connexion).
- Git est installé sur la machine ; le clonage utilise les identifiants Git déjà configurés.
- La position d'un agent va de 1 à 6 ; le port 3000 reste libre pour l'application du dépôt
  principal. Ports résultants : 3001 à 3006.
- Le niveau d'autorisation choisi est traduit vers le mode de permissions propre à chaque CLI
  (Demander / Auto · worktree / Tout auto dans le mode détaillé) ; pour un CLI qui ne supporte pas un
  niveau, le niveau le plus prudent disponible s'applique.
- Les états d'un agent sont déduits des signaux fournis par le CLI quand il en offre, sinon de son
  processus et de sa sortie terminal ; la précision peut varier selon le CLI.
- Les worktrees sont créés dans `.worktrees/` à la racine du dépôt, exclus du suivi Git localement.
  Les outils du dépôt principal (tests, linters, serveurs de dev) peuvent voir ce dossier ; c'est
  à l'utilisateur de l'exclure de leur configuration si besoin.
- Le nom de branche provisoire peut être renommé par l'agent ; l'application affiche la branche
  actuelle du worktree.
- Usage mono-utilisateur, en local ; pas de compte, pas de synchronisation entre machines.
- « Libre » est le seul workflow disponible tant que la spec Workflows n'est pas livrée.
- Le choix d'autorisation initial sera modifiable via la future fenêtre Réglages (⚙ › Agents CLI).
