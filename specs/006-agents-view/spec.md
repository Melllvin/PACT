# Feature Specification: Vue des agents

**Feature Branch**: `006-agents-view`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Feature 006 « Vue des agents ». Quand un orchestrateur lance et pilote des
agents, l'utilisateur doit voir tous les agents et savoir lesquels attendent une action. Trois parties :
(1) la colonne de droite « À faire » devient « Agents » : une ligne par agent du workspace
(orchestrateur compris) avec son nom, son rôle, son état, l'issue sur laquelle il travaille ; un bouton
d'action n'apparaît sur la ligne que lorsque nécessaire ; les éléments qui demandent une action restent
en tête et le compteur reste visible ; les éléments « À faire » sans agent restent visibles en tête ;
clic sur une ligne = ouvrir l'agent. (2) Les tuiles : orchestrateur en haut, ses sous-agents dessous,
chaque agent lancé par l'orchestrateur apparaît immédiatement. (3) Une nouvelle vue « Graphe » :
l'orchestrateur et les agents qu'il a lancés reliés, chaque nœud avec rôle, état en couleur, phase de la
chaîne de livraison, l'issue, le tour en cours des boucles dev ↔ test ; mises à jour en direct ; clic
sur un nœud = Focus ; sans orchestrateur, agents à plat. macOS et Windows, accessible au clavier et
lecteur d'écran. Hors périmètre : édition du graphe, historique des phases au-delà de la session."

## Contexte

Retour d'usage réel (2026-11-03) : un orchestrateur a lancé quatre agents pour deux boucles dev ↔
test ; l'utilisateur ne voyait que la tuile de l'orchestrateur et une colonne « À faire » avec un seul
élément. Il ne pouvait ni voir les agents, ni savoir où en était chacun. Le défaut d'affichage des
tuiles est corrigé à part (événement de lancement, PR #39) ; cette feature donne la vue d'ensemble.

## Références UI

Pas de maquette dédiée. Colonne de droite : emplacement et largeur de l'actuelle « À faire » (001 1b).
Vue « Graphe » : quatrième choix de la barre « Vues » (Tuiles, Comparer, Revue). Couleurs d'état
existantes (travaille, attente orange, erreur rouge, fini vert) et couleurs d'agent existantes.
Libellés : `docs/maquettes/CONSIGNES-UI.md`.

## Périmètre

**Inclus** : la colonne « Agents » qui remplace « À faire » (agents, demandes de l'orchestrateur,
alertes), la disposition des tuiles orchestrateur / sous-agents et la grille sans case vide avec
défilement au-delà de 3×2 (#40, #41, #47), la vue « Graphe » en lecture avec
navigation vers l'agent, l'enregistrement de qui a lancé chaque agent.

**Hors périmètre** :

- Édition du graphe (glisser pour relier, réordonner, réassigner une issue).
- Historique des phases au-delà de la session en cours ; statistiques de durée.
- Plusieurs orchestrateurs dans un même workspace (toujours un au plus, 003 FR-001).
- Nouvelles actions sur les agents : la colonne et le graphe ne proposent que les actions qui existent
  déjà (tuiles, À faire).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Voir tous mes agents et ce qu'ils attendent de moi (Priority: P1)

L'orchestrateur a lancé quatre agents. Dans la colonne de droite « Agents », l'utilisateur voit cinq
lignes : « ◎ Claude Code 1 · orchestrateur · travaille », « Claude Code 2 · test · 0001 · travaille »,
« Claude Code 3 · dev · 0001 · attend une réponse [Répondre] », etc. La ligne qui attend une réponse
est en tête avec son bouton ; les autres n'ont pas de bouton. Le compteur « Agents 5 · 1 à traiter »
reste visible. Une demande « ◎ Intégrer Claude Code 3 → main ? » apparaît en tête avec ses boutons.
Un clic sur une ligne ouvre l'agent.

**Why this priority**: c'est le manque constaté : savoir qui existe et qui a besoin de moi.

**Independent Test**: un workspace avec un orchestrateur et quatre agents dans des états différents
(faux CLI) : vérifier une ligne par agent avec rôle, état, issue, le bouton seulement là où une action
est due, l'ordre, le compteur et l'ouverture de l'agent au clic.

**Acceptance Scenarios**:

1. **Given** un workspace avec un orchestrateur et quatre agents, **When** l'utilisateur regarde la
   colonne, **Then** il voit une ligne par agent, l'orchestrateur en premier parmi ceux qui n'attendent
   rien, chacune avec nom, rôle, état et issue quand elle est connue.
2. **Given** un agent qui pose une question, **When** son état change, **Then** sa ligne passe en tête
   avec « Répondre » en moins d'une seconde, et le compteur d'éléments à traiter augmente.
3. **Given** un agent qui n'attend rien, **When** l'utilisateur regarde sa ligne, **Then** aucun bouton
   d'action n'y figure.
4. **Given** une demande d'intégration, une publication d'issues, une boucle arrêtée, un recouvrement
   de fichiers ou une alerte d'usage, **When** elle existe, **Then** elle apparaît en tête de colonne
   avec les mêmes actions qu'aujourd'hui dans « À faire ».
5. **Given** une ligne d'agent, **When** l'utilisateur la clique ou la valide au clavier, **Then** le
   Focus de l'agent s'ouvre.
6. **Given** un workspace sans orchestrateur, **When** l'utilisateur regarde la colonne, **Then** elle
   liste les agents de la même façon, sans rôle d'orchestrateur.

---

### User Story 2 - Voir les sous-agents de l'orchestrateur dans les tuiles (Priority: P1)

L'orchestrateur lance un agent : sa tuile apparaît à côté ou sous celle de l'orchestrateur, sans
action de l'utilisateur, et l'orchestrateur reste la plus grande tuile. L'orchestrateur occupe 2×2 cases
d'une grille de 3 colonnes ; les deux premiers agents remplissent la colonne de droite, les suivants
des rangées de 3 qu'on fait défiler (#41, #47). Sans orchestrateur, les tuiles prennent toute la place
disponible, sans case vide (#40).

**Why this priority**: sans les tuiles, l'utilisateur ne peut ni lire ni corriger le travail des
agents ; c'est la moitié du défaut constaté.

**Independent Test**: un faux orchestrateur lance un agent puis un deuxième ; vérifier que chaque tuile
apparaît sous l'orchestrateur et que l'orchestrateur reste la plus grande.

**Acceptance Scenarios**:

1. **Given** un orchestrateur, **When** il lance un agent, **Then** la tuile de l'agent apparaît en
   moins d'une seconde, dans la rangée sous l'orchestrateur.
2. **Given** un orchestrateur et deux sous-agents, **When** la fenêtre fait 1024 × 768, **Then**
   l'orchestrateur occupe les deux colonnes de gauche sur toute la hauteur, les deux agents la colonne de
   droite, sans défilement ni case vide.
2a. **Given** un orchestrateur et cinq sous-agents, **When** la fenêtre fait 1024 × 768, **Then** les trois
   derniers agents sont sur une rangée de 3 sous l'orchestrateur, atteinte en faisant défiler la grille
   verticalement ; aucune tuile ne fait moins de 120 px de haut ; pas de défilement horizontal.
2b. **Given** un seul terminal sans orchestrateur, **When** la vue Tuiles s'affiche, **Then** il occupe
   toute la grille ; avec deux terminaux, chacun la moitié ; avec sept, la grille montre 3×2 tuiles et
   se fait défiler pour la septième.
2c. **Given** la colonne « Agents » ouverte, **When** la grille s'affiche, **Then** les cases se réduisent
   en largeur sans changer la disposition en 3 colonnes.
3. **Given** un sous-agent fermé par l'orchestrateur, **When** il se ferme, **Then** sa tuile et sa ligne
   disparaissent.

---

### User Story 3 - Comprendre où en est la chaîne d'un coup d'œil (Priority: P2)

L'utilisateur choisit la vue « Graphe ». Il voit l'orchestrateur relié à ses agents. Chaque nœud montre
le rôle, l'état en couleur, la phase (« spec », « design », « dev ↔ test 2/3 », « recap ») et l'issue.
Les agents d'une même boucle dev ↔ test sont regroupés et reliés entre eux. Les nœuds changent pendant
que les agents travaillent. Un clic sur un nœud ouvre le Focus de l'agent.

**Why this priority**: utile dès qu'il y a plusieurs boucles, mais la colonne de l'US1 couvre déjà le
besoin de base.

**Independent Test**: un workspace avec un orchestrateur, un agent spec, deux boucles dev ↔ test à des
tours différents ; vérifier les nœuds, les liens, les regroupements, les tours affichés, la mise à jour
en direct et l'ouverture du Focus.

**Acceptance Scenarios**:

1. **Given** un orchestrateur et ses agents, **When** l'utilisateur choisit la vue « Graphe », **Then**
   l'orchestrateur apparaît relié à chaque agent qu'il a lancé.
2. **Given** une boucle dev ↔ test au tour 2 de 3, **When** le graphe s'affiche, **Then** ses deux
   agents sont regroupés sous l'issue de la boucle avec « tour 2/3 ».
3. **Given** un agent qui change d'état, **When** le changement arrive, **Then** la couleur et le libellé
   de son nœud changent en moins d'une seconde.
4. **Given** un nœud, **When** l'utilisateur le clique ou le valide au clavier, **Then** le Focus de
   l'agent s'ouvre.
5. **Given** un workspace sans orchestrateur, **When** l'utilisateur choisit le graphe, **Then** les
   agents apparaissent à plat, sans liens.
6. **Given** un lecteur d'écran, **When** l'utilisateur parcourt le graphe, **Then** chaque nœud est
   annoncé avec son nom, son rôle, son état, sa phase et son issue, et les liens sont décrits
   (« lancé par Claude Code 1 »).

---

### User Story 4 - Fermer et relancer l'orchestrateur avec ses agents (Priority: P1)

L'utilisateur ferme l'orchestrateur : les agents qu'il a lancés se ferment avec lui. Il le relance : ses
agents reviennent, et PACT peut relancer le travail de ceux qui travaillaient.

**Why this priority**: sans cela, fermer l'orchestrateur laisse des agents orphelins qui consomment
l'usage, et la relance oblige à tout reprendre à la main.

**Independent Test**: un orchestrateur et deux agents (l'un travaille, l'autre attend une consigne) ;
fermer l'orchestrateur ferme les trois ; le relancer avec « Reprendre le travail » relance les trois,
envoie la consigne de reprise au seul agent qui travaillait.

**Acceptance Scenarios**:

1. **Given** un orchestrateur et ses agents, **When** l'utilisateur ferme l'orchestrateur, **Then** la
   boîte de fermeture liste ses agents et le choix du worktree (garder par défaut) s'applique à tous ;
   tous se ferment.
2. **Given** un agent lancé par l'utilisateur dans le même workspace, **When** l'orchestrateur est
   fermé, **Then** cet agent reste ouvert.
3. **Given** un orchestrateur fermé avec ses agents (worktrees gardés), **When** l'utilisateur le
   relance, **Then** ses agents sont relancés sur leurs worktrees, avec leur rôle et leur lien.
4. **Given** la relance, **When** l'utilisateur coche « Reprendre le travail » (coché par défaut),
   **Then** chaque agent qui travaillait au moment de la fermeture reçoit une consigne de reprise ;
   les autres restent en attente, sans consigne.
5. **Given** un sous-agent fermé seul, **When** l'orchestrateur reste ouvert, **Then** rien d'autre ne
   se ferme.

---

### User Story 5 - Faire d'un agent l'orchestrateur (Priority: P2)

L'utilisateur a lancé un agent sans rôle d'orchestrateur et veut qu'il pilote le workspace. Il le
désigne orchestrateur depuis la tuile ou le Focus, sans perdre sa conversation.

**Why this priority**: aujourd'hui le rôle ne se choisit qu'au lancement ; il faut relancer un agent et
perdre son contexte pour en faire un orchestrateur.

**Independent Test**: un agent sans rôle ; « Faire orchestrateur » → l'agent redémarre sur la même
session avec l'accès orchestrateur, sa tuile passe en haut, il peut lancer un agent.

**Acceptance Scenarios**:

1. **Given** un workspace sans orchestrateur et un agent (sans rôle ou avec un autre rôle), **When**
   l'utilisateur choisit « Faire orchestrateur » dans le menu de la tuile ou du Focus et confirme,
   **Then** l'agent devient l'orchestrateur, redémarre en reprenant sa session, et ses outils
   d'orchestrateur sont disponibles.
2. **Given** un workspace qui a déjà un orchestrateur, **When** l'utilisateur ouvre le menu d'un autre
   agent, **Then** « Faire orchestrateur » est indisponible, avec la raison (« Claude Code 1 est déjà
   l'orchestrateur »).
3. **Given** un CLI qui ne sait pas être orchestrateur, **When** l'utilisateur ouvre le menu, **Then**
   l'option est indisponible, avec la raison.
4. **Given** l'agent devenu orchestrateur, **When** il lance des agents, **Then** ils sont liés à lui
   (FR-011) comme pour un orchestrateur lancé comme tel.
5. **Given** un agent qui travaille, **When** l'utilisateur confirme, **Then** la confirmation prévient
   que l'agent redémarre et que la tâche en cours est interrompue.

---

### Edge Cases

- Un agent lancé par l'utilisateur dans un workspace qui a un orchestrateur : il apparaît dans la
  colonne et dans le graphe, sans lien vers l'orchestrateur (« lancé par vous »).
- L'orchestrateur est fermé ou perd son rôle : ses anciens sous-agents restent listés ; le graphe les
  montre à plat.
- Après un redémarrage de PACT, les agents « à reprendre » restent dans la colonne et le graphe, avec
  leur lien d'origine.
- Un agent sans rôle, sans issue ou hors boucle : la ligne et le nœud omettent ces champs, sans
  « inconnu ».
- Un agent qui a plusieurs choses à traiter (question et changements à relire) : une seule ligne, avec
  l'action la plus urgente selon l'ordre actuel d'« À faire », et le compteur compte chaque élément.
- Six agents et plusieurs alertes : la colonne défile ; le compteur et l'en-tête restent visibles.
- Fenêtre étroite : la colonne se réduit comme « À faire » aujourd'hui ; le graphe se réorganise pour
  tenir sans défilement horizontal jusqu'à 1024 px de large.
- Terminaux libres : ils ne sont ni des agents ni des nœuds du graphe.

## Requirements *(mandatory)*

### Functional Requirements

**Colonne « Agents »**

- **FR-001**: La colonne de droite « À faire » MUST devenir « Agents » et lister une ligne par agent du
  workspace, orchestrateur compris, et aucune pour les terminaux libres.
- **FR-002**: Chaque ligne MUST montrer le nom de l'agent (CLI et numéro), sa couleur, son rôle quand
  il en a un, son état en mots (démarre, travaille, attend une consigne, attend une réponse, fini,
  erreur, limite de débit, reprise à HH:MM) et l'issue sur laquelle il travaille quand elle est connue.
- **FR-003**: Une ligne MUST porter les boutons d'action de cet agent seulement quand un élément
  « À faire » existe pour lui (réponse, changements à relire, limite de débit, consigne attendue), avec
  les mêmes actions qu'aujourd'hui ; sinon elle MUST n'en porter aucun.
- **FR-004**: Les éléments qui ne concernent pas une ligne d'agent seule (demande d'intégration,
  publication d'issues, boucle arrêtée, recouvrement de fichiers, alerte d'usage) MUST rester affichés,
  avec leurs actions actuelles, en tête de la colonne.
- **FR-005**: L'ordre MUST être : éléments et agents qui demandent une action, dans l'ordre actuel
  d'« À faire » ; puis l'orchestrateur ; puis les autres agents par numéro.
- **FR-006**: L'en-tête MUST montrer le nombre d'agents et le nombre d'éléments à traiter, et rester
  visible quand la colonne défile.
- **FR-007**: Cliquer ou valider au clavier une ligne d'agent (hors bouton) MUST ouvrir son Focus.
- **FR-008**: Une ligne MUST refléter un changement d'état, de rôle, d'issue ou d'action en moins d'une
  seconde.

**Tuiles**

- **FR-009**: Un agent lancé par l'orchestrateur MUST avoir sa tuile en moins d'une seconde après son
  lancement, sans action de l'utilisateur.
- **FR-010** (#41): Avec un orchestrateur, sa tuile MUST occuper 2 colonnes × 2 rangées en haut à
  gauche d'une grille de 3 colonnes et rester la plus grande ; les deux premiers autres agents MUST
  occuper la colonne de droite, les suivants des rangées de 3 en dessous. Remplace 004 FR-006a
  (orchestrateur pleine largeur).
- **FR-010a** (#40, #47): La grille MUST montrer au plus 3 colonnes × 2 rangées dans la hauteur visible ;
  au-delà, elle MUST défiler verticalement, jamais horizontalement. En dessous de 6 tuiles, sans
  orchestrateur, les tuiles MUST occuper toute la place disponible (1 tuile : toute la grille ;
  2 : deux colonnes ; 3 : trois colonnes ; 4 : 2×2 ; 5–6 : 3×2). Ouvrir la colonne « Agents » MUST
  réduire la largeur des cases sans changer le nombre de colonnes. Remplace 001 FR-019.
- **FR-010b** (#40): La grille MUST NOT montrer de case vide permanente ; une seule case « + » (ajout
  d'un agent) MUST apparaître si une place reste libre dans la dernière rangée, et MUST NOT ajouter de
  rangée à elle seule.

**Lien de lancement**

- **FR-011**: Le système MUST enregistrer, pour chaque agent, qui l'a lancé (l'utilisateur ou
  l'orchestrateur, désigné) et le conserver après un redémarrage.

**Vue « Graphe »**

- **FR-012**: La barre « Vues » MUST proposer « Graphe » ; la vue MUST être disponible dès qu'un agent
  existe dans le workspace.
- **FR-013**: Le graphe MUST montrer un nœud par agent et un lien de l'orchestrateur vers chaque agent
  qu'il a lancé ; les agents lancés par l'utilisateur et tous les agents d'un workspace sans
  orchestrateur MUST apparaître sans lien.
- **FR-014**: Chaque nœud MUST montrer le nom, la couleur, le rôle, l'état (en couleur et en mots), la
  phase et l'issue. La phase MUST être : celle de son rôle (spec, design, recap) ; « dev ↔ test N/M »
  quand l'agent est dans une boucle en cours (N le tour courant, M le maximum) ; « boucle arrêtée »
  ou « boucle terminée » à la fin ; aucune sinon.
- **FR-015**: Les deux agents d'une même boucle MUST être regroupés sous l'issue de la boucle et reliés
  entre eux.
- **FR-016**: Le graphe MUST se mettre à jour en moins d'une seconde quand un agent est lancé, fermé ou
  change d'état, de phase ou de tour.
- **FR-017**: Cliquer ou valider au clavier un nœud MUST ouvrir le Focus de l'agent.
- **FR-018**: Le graphe MUST être navigable au clavier (passage de nœud en nœud) et chaque nœud MUST
  être annoncé aux technologies d'assistance avec nom, rôle, état, phase, issue et qui l'a lancé.
- **FR-019**: Le graphe MUST être en lecture seule : aucune action sur un nœud n'en change les liens ni
  l'organisation.

**Plateformes**

**Tuiles et terminal**

- **FR-021**: Le terminal d'une tuile MUST occuper exactement la zone libre de la tuile : aucune ligne
  (prompt, ligne d'état) cachée sous un bouton ni coupée en bas.
- **FR-022**: Les boutons d'action d'une tuile MUST apparaître au survol de la tuile ou quand l'un
  d'eux a le focus clavier (pas la tuile : xterm garde le focus de la tuile), sans jamais recouvrir le texte du terminal ; une action due reste signalée sans
  survol (contour de la tuile, ligne dans la colonne « Agents »).

**Fermeture et relance liées**

- **FR-023**: Fermer l'orchestrateur MUST fermer les agents qu'il a lancés (FR-011) ; la boîte de
  fermeture MUST les lister et appliquer à tous le choix du worktree, « garder » par défaut.
- **FR-024**: Fermer un agent qui n'est pas l'orchestrateur MUST ne fermer que lui.
- **FR-025**: Relancer un orchestrateur fermé avec ses agents MUST relancer ces agents sur leurs
  worktrees gardés, avec leur rôle et leur lien.
- **FR-026**: La relance MUST proposer « Reprendre le travail » (coché par défaut) : chaque agent qui
  travaillait à la fermeture reçoit une consigne de reprise ; les autres restent en attente.

**Devenir orchestrateur**

- **FR-027**: Le menu d'un agent (tuile et Focus) MUST proposer « Faire orchestrateur » quand le
  workspace n'a pas d'orchestrateur et que son CLI peut l'être ; sinon l'option MUST être
  indisponible avec sa raison.
- **FR-028**: Après confirmation, l'agent MUST prendre le rôle d'orchestrateur et redémarrer en
  reprenant sa session, avec l'accès d'orchestrateur ; la confirmation MUST prévenir de
  l'interruption s'il travaille.

- **FR-020**: Tout ce qui précède MUST fonctionner à l'identique sur macOS et Windows.

### Key Entities

- **Ligne d'agent** : dérivée de l'agent (nom, couleur, rôle, état, issue, lien de lancement) et de ses
  éléments « À faire » ; jamais stockée.
- **Lien de lancement** : qui a lancé un agent (l'utilisateur, ou un orchestrateur désigné) ; stocké
  avec l'agent.
- **Nœud du graphe** : un agent et sa phase ; **lien** : orchestrateur → agent lancé, ou dev ↔ test d'une
  même boucle ; dérivés, jamais stockés.
- **Phase** : dérivée du rôle et de l'état de la boucle de 004 (tour courant, maximum, fin).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Avec un orchestrateur et cinq agents, l'utilisateur identifie en moins de 5 secondes
  quels agents attendent une action, sans ouvrir de tuile.
- **SC-002**: 100 % des agents lancés par l'orchestrateur ont leur tuile et leur ligne en moins d'une
  seconde.
- **SC-003**: Un changement d'état d'agent est visible dans la colonne et le graphe en moins d'une
  seconde dans 95 % des cas.
- **SC-004**: Aucune ligne d'agent ne porte de bouton d'action quand aucun élément « À faire » ne le
  concerne (0 bouton superflu dans les tests de chaque état).
- **SC-005**: Toutes les actions disponibles aujourd'hui dans « À faire » restent accessibles depuis la
  colonne (aucune régression des tests existants de « À faire »).
- **SC-006**: Le graphe et la colonne s'utilisent entièrement au clavier, et un audit d'accessibilité
  automatique ne relève aucune violation sérieuse.
- **SC-007**: À 1024 × 768, le graphe d'un orchestrateur et de cinq agents tient sans défilement
  horizontal.

## Assumptions

- Un workspace a au plus un orchestrateur (003) et six agents (001) : le graphe reste petit ; une
  disposition calculée simple suffit, sans zoom ni déplacement.
- L'issue d'un agent est connue par les boucles de 004 (agent test et dev d'une issue) et par la
  consigne de lancement quand l'orchestrateur la nomme ; sinon elle est omise.
- Les agents lancés avant cette feature n'ont pas de lien enregistré : ils sont considérés lancés par
  l'utilisateur (le journal « ◎ Actions » de 003 n'est gardé qu'en mémoire, il ne survit pas à un
  redémarrage).
- « À faire » disparaît comme nom de colonne, mais ses éléments, leur ordre et leurs actions sont
  conservés ; les raccourcis ou libellés qui y renvoient sont renommés « Agents ».
- La vue « Graphe » n'apporte pas d'action nouvelle : les actions restent sur la ligne et la tuile.
- Dépendances : 003 (orchestrateur, journal des actions), 004 (rôles, issues, boucles), 005 (alertes
  d'usage dans la colonne).
