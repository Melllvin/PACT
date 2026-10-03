# Feature Specification: Revue et intégration

**Feature Branch**: `002-review-integration`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description: "Revue et intégration pour PACT (suite du socle 001-agent-workspace-core) :
vue Revue, diff des changements de chaque agent par rapport à la branche principale, commentaires
sur le diff renvoyés à l'agent comme consigne, colonne Décision (intégrer / renvoyer / abandonner),
intégration dans la branche principale avec squash, détection et aide à la résolution des conflits,
onglet Changements dans le Focus et bouton Revue sur les tuiles. Écrans de référence 1h et 1q de
docs/maquettes/Maquettes hi-fi.dc.html, apparence selon docs/maquettes/Maquette interactive.dc.html
(research.md R17 de 001), libellés selon docs/maquettes/CONSIGNES-UI.md. macOS et Windows."

## Références UI

Structure et libellés : écrans 1h (« Revue — Focus, la colonne devient « Décision » ») et 1q
(« Intégration — conflit avec main ») de `docs/maquettes/Maquettes hi-fi.dc.html`, avec leurs notes
dans `docs/maquettes/Wireframes Agents v3.dc.html`. Apparence (palette, typographie, effets) :
`docs/maquettes/Maquette interactive.dc.html`, comme le socle (research.md R17 de
`specs/001-agent-workspace-core`). Libellés système concis, abrégés par une icône avec légende :
`docs/maquettes/CONSIGNES-UI.md`.

## Périmètre

**Inclus** : onglet Changements du Focus (la revue), vue Revue, bouton « Revue → » sur les tuiles
et dans À faire, colonne Décision qui remplace À faire pendant la revue, diff par fichier avec
fichiers vus, commentaires sur une ligne envoyés à l'agent, raccourcis qui tapent une consigne dans
le CLI de l'agent, état des tests et des conflits, intégration locale dans la branche principale
(squash par défaut), écran de conflit 1q (rendre la main à l'agent ou résoudre conflit par
conflit), renvoi à l'agent et abandon.

**Hors périmètre** :

- Aperçus et comparaison A/B : onglet Aperçu, ligne « Aperçu comparé à » de la colonne Décision,
  vue Comparer, sort de la version non gardée (spec Aperçus).
- Pousser vers un dépôt distant, ouvrir une pull request, merge sur GitHub (spec Workflows).
- Revue croisée par un autre agent (spec Workflows).
- Raccourcis clavier personnalisables (spec Réglages).

Ce lot active ce que le socle laissait inactif : la vue Revue (FR-006 de 001) et l'onglet
Changements du Focus (FR-033 de 001). L'onglet Aperçu reste inactif.

## Clarifications

### Session 2026-10-03

- Q: Quand PACT doit-il lancer les tests du dépôt pour la colonne Décision ? → A: dans le worktree
  de l'agent, à l'ouverture de la revue quand aucun résultat ne correspond à l'état actuel des
  changements, et à la demande (FR-017).
- Q: L'intégration propose-t-elle, en plus du squash, de garder les commits de l'agent ? → A: oui,
  squash par défaut et « garder les commits » dans le menu ▾ ; les changements non commités forment
  alors un dernier commit (FR-019).
- Q: Le commit d'intégration doit-il passer par les crochets Git du dépôt (pre-commit,
  commit-msg) ? → A: oui ; un crochet qui refuse fait échouer l'intégration sans toucher la branche
  principale (FR-023).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Relire les changements d'un agent (Priority: P1)

Un agent a fini son tour. Sa tuile et la colonne À faire proposent « Revue → ». L'utilisateur clique :
le Focus de la tuile s'ouvre sur l'onglet Changements (écran 1h). L'en-tête de l'onglet indique le
nombre de fichiers modifiés (« Changements · 12 »), la branche de l'agent, le total des lignes
ajoutées et retirées et le nombre de fichiers vus (« +214 −38 · 3 / 12 vus »). À gauche, la liste
des fichiers, chacun avec ses lignes ajoutées et une case « vu ». Au centre, le diff du fichier
choisi par rapport à la branche principale. La colonne de droite passe de « À faire » à
« Décision ». En bas, le terminal de l'agent reste là, avec la même session.

**Why this priority**: sans voir ce qu'un agent a changé, l'utilisateur ne peut ni lui répondre ni
garder son travail. Tout le reste de ce lot en dépend.

**Independent Test**: lancer un agent (faux CLI) qui modifie, ajoute et supprime des fichiers dans
son worktree, avec et sans commit ; ouvrir « Revue → » ; vérifier la liste des fichiers, les
totaux, le diff de chaque fichier et le suivi des fichiers vus.

**Acceptance Scenarios**:

1. **Given** un agent dont le worktree a des fichiers modifiés, ajoutés et supprimés (commités ou
   non), **When** l'utilisateur ouvre sa revue, **Then** chaque fichier apparaît une fois avec ses
   lignes ajoutées et retirées, et les totaux de l'en-tête en sont la somme.
2. **Given** la revue ouverte, **When** l'utilisateur choisit un fichier, **Then** le diff de ce
   fichier par rapport à la branche principale s'affiche, lignes ajoutées et retirées distinguées,
   avec les numéros de ligne.
3. **Given** un fichier affiché, **When** l'utilisateur coche « vu », **Then** le compteur
   « N / M vus » augmente, et le fichier reste vu tant qu'il ne change pas.
4. **Given** un fichier vu, **When** l'agent le modifie de nouveau, **Then** il redevient non vu et
   l'en-tête annonce « Nouveaux changements : +3 −1 · revoir ».
5. **Given** un agent sans aucun changement, **When** l'utilisateur ouvre l'onglet Changements,
   **Then** un état vide indique qu'il n'y a rien à relire, sans erreur.
6. **Given** un fichier binaire ou très gros, **When** il est choisi, **Then** le diff n'est pas
   affiché ligne à ligne : un message indique le type de changement et la taille.
7. **Given** la revue ouverte, **When** l'utilisateur clique « ‹ Tuiles » ou appuie sur Échap hors
   du terminal, **Then** il revient aux tuiles et la colonne redevient « À faire ».

---

### User Story 2 - Intégrer le travail d'un agent dans la branche principale (Priority: P1)

Dans la colonne Décision, l'utilisateur voit l'état des tests, l'absence de conflit avec la branche
principale et les fichiers non vus. Il clique « ✓ Intégrer ». Par défaut, les changements de
l'agent deviennent un seul commit sur la branche principale (« Squash en 1 commit ▾ »), avec un
message proposé qu'il peut modifier. Deux cases, cochées par défaut, règlent la suite : « Fermer la
tuile » et « Supprimer worktree et branche ». « Conserver le worktree » garde l'agent et son
worktree.

**Why this priority**: c'est le but du travail des agents : qu'il arrive dans le dépôt. Sans
intégration, l'utilisateur doit sortir de PACT pour fusionner à la main.

**Independent Test**: faire produire un changement à un agent, ouvrir sa revue, intégrer ; vérifier
qu'un seul nouveau commit est sur la branche principale avec le contenu de l'agent, et que la
tuile, le worktree et la branche suivent les cases choisies.

**Acceptance Scenarios**:

1. **Given** un agent dont les changements n'entrent pas en conflit avec la branche principale,
   **When** l'utilisateur intègre en squash, **Then** la branche principale reçoit exactement un
   nouveau commit qui contient tous les changements de l'agent, commités ou non, avec le message
   validé par l'utilisateur.
2. **Given** l'option « garder les commits » choisie dans le menu ▾, **When** l'utilisateur
   intègre, **Then** les commits de l'agent sont ajoutés à la branche principale avec leurs
   messages, et les changements non commités forment un dernier commit.
3. **Given** les deux cases cochées, **When** l'intégration réussit, **Then** la tuile se ferme et
   le worktree et la branche de l'agent sont supprimés.
4. **Given** « Conserver le worktree », **When** l'intégration réussit, **Then** l'agent reste
   ouvert, attend une nouvelle tâche, et sa revue repart de la nouvelle branche principale (rien à
   relire).
5. **Given** des fichiers non vus ou des tests en échec, **When** l'utilisateur intègre, **Then**
   l'intégration reste possible ; la colonne Décision montre ces points avant le clic (« ○ 9
   fichiers non vus », « ✕ Tests en échec »).
6. **Given** une intégration réussie, **When** l'utilisateur revient aux tuiles, **Then** une
   notification brève confirme « ✓ Intégré · branche → main ».
7. **Given** le dépôt principal a des changements locaux non commités sur des fichiers que
   l'intégration toucherait, **When** l'utilisateur intègre, **Then** l'intégration est refusée
   avant toute modification, avec la liste de ces fichiers.

---

### User Story 3 - Commenter le diff et renvoyer à l'agent (Priority: P2)

En relisant, l'utilisateur clique sur une ligne du diff et écrit un commentaire (« Le TTL devrait
venir de la config. »). Le commentaire s'affiche sous la ligne, marqué « → envoyé à l'agent ↓ », et
arrive dans l'invite du CLI de l'agent, en bas, avec le fichier et la ligne (« Commentaire sur
otp.ts:3 — le TTL devrait venir de la config. »). Des raccourcis au-dessus du terminal tapent les
demandes fréquentes : « Corriger les commentaires · 1 », « Tests en échec », « Conflit avec main ».
Les nouveaux changements de l'agent s'ajoutent à la revue sans la quitter.

**Why this priority**: renvoyer du travail précis évite de tout réexpliquer dans le terminal ; mais
on peut déjà relire et intégrer sans.

**Independent Test**: ouvrir une revue, commenter une ligne, vérifier le texte reçu par le faux CLI
(fichier, ligne, commentaire) ; utiliser chaque raccourci et vérifier le texte tapé.

**Acceptance Scenarios**:

1. **Given** un diff affiché, **When** l'utilisateur commente une ligne et valide, **Then** le CLI
   de l'agent reçoit dans son invite une consigne qui cite le fichier, le numéro de ligne et le
   commentaire, et le commentaire reste affiché sous la ligne.
2. **Given** un ou plusieurs commentaires non encore traités, **When** l'utilisateur clique
   « Corriger les commentaires · N », **Then** une seule consigne qui les reprend tous est tapée dans
   l'invite.
3. **Given** des tests en échec ou un conflit avec la branche principale, **When** l'utilisateur
   clique le raccourci correspondant, **Then** une consigne qui décrit le problème (tests en échec et
   leur sortie résumée, ou fichiers en conflit) est tapée dans l'invite.
4. **Given** un raccourci ou un commentaire, **When** il est tapé, **Then** il n'est pas validé à la
   place de l'utilisateur si l'agent attend une autre réponse (question, autorisation) ; il est
   envoyé quand l'agent est prêt à recevoir une consigne.
5. **Given** la colonne Décision, **When** l'utilisateur écrit une demande et clique « Renvoyer à
   l'agent », **Then** la demande est envoyée comme consigne et la vue revient aux tuiles.
6. **Given** l'agent travaille après un renvoi, **When** ses changements arrivent, **Then** la revue
   les ajoute, signale les fichiers à revoir, et la ligne « Agent : correction en cours » de la
   colonne Décision suit son état.

---

### User Story 4 - Résoudre un conflit avec la branche principale (Priority: P2)

L'utilisateur clique « Intégrer » mais la branche principale a reçu d'autres commits qui touchent
les mêmes lignes. L'écran de conflit s'ouvre (écran 1q) : un onglet « Conflits · 2 », la liste des
fichiers en conflit et ceux « sans conflit », et pour chaque conflit les deux versions côte à côte
(« main · « Ajout SSO » a41f2 » et « cette version »). La colonne s'appelle « Intégration ». Option
recommandée : « Demander à l'agent » (il met sa branche à jour depuis la branche principale dans
son worktree, résout et relance les tests). Sinon, l'utilisateur choisit pour chaque conflit :
« Garder main », « Garder cette version », « Les deux » ou « Modifier… ». « Terminer l'intégration »
reste inactif tant qu'il reste un conflit. « Annuler l'intégration » ne touche à rien : la branche
principale n'est jamais modifiée tant que les conflits ne sont pas résolus.

**Why this priority**: avec plusieurs agents sur le même dépôt, les conflits arrivent dès le
deuxième agent intégré ; sans aide, l'utilisateur doit quitter PACT.

**Independent Test**: faire modifier la même ligne par la branche principale et par un agent,
intégrer, vérifier que rien n'a changé sur la branche principale ; résoudre par les deux voies et
vérifier le commit final.

**Acceptance Scenarios**:

1. **Given** des changements en conflit avec la branche principale, **When** l'utilisateur clique
   « Intégrer », **Then** l'écran de conflit s'ouvre et la branche principale, son dossier de
   travail et l'index du dépôt principal restent inchangés.
2. **Given** l'écran de conflit, **When** l'utilisateur clique « Demander à l'agent », **Then** une
   consigne qui demande de mettre la branche à jour depuis la branche principale, de résoudre les
   conflits et de relancer les tests est tapée dans l'invite de l'agent, et l'intégration est mise
   en attente jusqu'au retour de l'agent.
3. **Given** un conflit affiché, **When** l'utilisateur choisit « Garder main », « Garder cette
   version » ou « Les deux », **Then** le conflit est marqué résolu et le compteur « N / M résolu »
   avance.
4. **Given** un conflit, **When** l'utilisateur choisit « Modifier… », **Then** il peut éditer le
   résultat du conflit dans PACT, ou ouvrir le fichier dans son éditeur (« Ouvrir dans l'éditeur
   ▾ ») ; le conflit est résolu quand le fichier ne contient plus de marqueurs de conflit.
5. **Given** tous les conflits résolus, **When** l'utilisateur clique « Terminer l'intégration »,
   **Then** l'intégration se fait selon le choix squash / garder les commits, avec les résolutions
   choisies.
6. **Given** l'écran de conflit, **When** l'utilisateur clique « Annuler l'intégration », **Then**
   les résolutions en cours sont abandonnées, le worktree de l'agent revient à son état d'avant et
   la branche principale n'a pas bougé.
7. **Given** la branche principale a reçu des commits depuis la création de l'agent sans conflit
   avec ses changements, **When** l'utilisateur intègre, **Then** l'intégration réussit sans écran
   de conflit.

---

### User Story 5 - Vue Revue et abandon (Priority: P3)

La vue « Revue » de la barre d'outils, avec un badge du nombre d'agents qui ont des changements à
relire, ouvre la revue du premier de ces agents ; un sélecteur passe à l'agent suivant sans revenir
aux tuiles. Depuis la colonne Décision, « ✕ Abandonner » écarte le travail d'un agent : après
confirmation, ses changements ne sont pas intégrés, et l'utilisateur choisit, comme à la fermeture
d'un agent, de garder ou de supprimer son worktree et sa branche.

**Why this priority**: utile dès trois ou quatre agents, mais le bouton « Revue → » des tuiles suffit
pour relire un agent à la fois.

**Independent Test**: produire des changements chez deux agents, vérifier le badge, parcourir les
deux revues depuis la vue Revue, abandonner l'un et vérifier que la branche principale est
inchangée.

**Acceptance Scenarios**:

1. **Given** un workspace où aucun agent n'a de changement, **When** l'utilisateur regarde la barre
   d'outils, **Then** la vue Revue est visible mais inactive, sans badge.
2. **Given** deux agents avec des changements à relire, **When** l'utilisateur ouvre la vue Revue,
   **Then** le badge indique 2 et la revue du premier agent s'ouvre, avec un sélecteur de pastilles
   pour passer au second.
3. **Given** une revue ouverte, **When** l'utilisateur clique « ✕ Abandonner » et confirme, **Then**
   aucun changement n'atteint la branche principale et la question « garder ou supprimer le
   worktree et la branche » de la fermeture d'un agent est posée.
4. **Given** un agent intégré ou abandonné, **When** le badge se met à jour, **Then** il ne le
   compte plus.

---

### Edge Cases

- La branche principale est extraite dans le dépôt principal avec des changements locaux : seuls
  ceux qui touchent les mêmes fichiers que l'intégration la bloquent (US2/AC7) ; les autres restent
  intacts.
- La branche principale n'est pas extraite dans le dépôt principal (l'utilisateur y travaille sur
  une autre branche) : l'intégration met à jour la branche principale sans changer de branche ni
  toucher au dossier de travail.
- L'agent travaille encore quand l'utilisateur clique « Intégrer » : PACT demande confirmation, car
  les changements en cours d'écriture peuvent être incomplets ; l'intégration prend l'état du
  worktree au moment du clic.
- L'agent modifie des fichiers pendant l'écran de conflit : les résolutions déjà choisies restent,
  et les fichiers touchés repassent en conflit si besoin.
- Le worktree de l'agent a disparu ou la branche a été supprimée hors de PACT : la revue l'indique
  et propose seulement d'abandonner.
- Un fichier renommé apparaît une fois, avec son ancien et son nouveau nom.
- Des fichiers ignorés par Git (`node_modules`, sorties de build) n'apparaissent pas dans la revue et
  ne sont jamais intégrés.
- Des fins de ligne différentes entre macOS et Windows ne doivent pas faire apparaître un fichier
  entier comme modifié dans le diff. Un fichier qui ne diffère que par ses fins de ligne reste dans
  la liste, marqué « fins de ligne seulement », puisqu'il serait intégré.
- Chemins avec espaces et accents, sur macOS et Windows, dans la liste, le diff et l'intégration.
- Une intégration échoue en cours de route (crochet Git qui refuse le commit, disque plein) : la
  branche principale revient à son état d'avant et l'erreur est affichée telle que Git la donne.
- Pas de commande de test connue pour le dépôt : la ligne Tests indique « Tests : non configurés »
  et propose d'en saisir une.
- Plusieurs intégrations lancées coup sur coup pour deux agents : elles se font l'une après l'autre ;
  la seconde voit les commits de la première.

## Requirements *(mandatory)*

### Functional Requirements

**Accès à la revue**

- **FR-001**: Le système MUST activer l'onglet Changements du Focus et la vue Revue (inactifs dans le
  socle) ; l'onglet Aperçu reste inactif.
- **FR-002**: Le système MUST afficher « Revue → » sur la tuile et dans À faire d'un agent qui a
  terminé son tour avec des changements à relire ; le bouton ouvre le Focus de cet agent sur
  l'onglet Changements.
- **FR-003**: La vue Revue MUST porter un badge égal au nombre d'agents du workspace qui ont des
  changements non intégrés ; elle MUST être inactive à zéro ; ouverte, elle MUST afficher la revue
  du premier de ces agents avec le sélecteur de pastilles du Focus pour passer aux autres.
- **FR-004**: Pendant la revue, la colonne de droite MUST s'intituler « Décision » à la place
  d'« À faire », au même endroit ; elle MUST redevenir « À faire » en quittant la revue.

**Changements et diff**

- **FR-005**: Les changements d'un agent MUST être la différence entre le point de départ commun
  avec la branche principale et l'état actuel de son worktree, commits et changements non commités
  compris, fichiers ignorés par Git exclus.
- **FR-006**: L'onglet Changements MUST afficher le nombre de fichiers, la branche de l'agent, le
  total des lignes ajoutées et retirées, et le nombre de fichiers vus sur le total.
- **FR-007**: La liste des fichiers MUST indiquer pour chacun le type de changement (ajouté,
  modifié, supprimé, renommé), les lignes ajoutées et retirées, et une case « vu ».
- **FR-008**: Le diff d'un fichier MUST distinguer lignes ajoutées, retirées et inchangées, avec les
  numéros de ligne des deux côtés ; un fichier binaire ou trop gros MUST être signalé sans diff
  ligne à ligne.
- **FR-009**: Un fichier vu MUST redevenir non vu quand son contenu change ; la revue MUST alors
  annoncer les nouveaux changements (« Nouveaux changements : +N −M · revoir »).
- **FR-010**: La revue MUST se mettre à jour d'elle-même quand le worktree de l'agent change, sans
  que l'utilisateur ait à la rouvrir.
- **FR-011**: Les fichiers vus MUST être conservés après un redémarrage de l'application.

**Commentaires et consignes**

- **FR-012**: L'utilisateur MUST pouvoir commenter une ligne du diff ; le commentaire MUST être
  affiché sous la ligne et envoyé à l'agent comme consigne citant le fichier, le numéro de ligne et
  le texte.
- **FR-013**: La revue MUST proposer au-dessus du terminal de l'agent des raccourcis qui tapent une
  consigne : « Corriger les commentaires · N » (tous les commentaires non traités), « Tests en
  échec » (si les tests échouent) et « Conflit avec main » (s'il y a un conflit).
- **FR-014**: Une consigne tapée par la revue MUST attendre que l'agent soit prêt à recevoir une
  consigne ; elle ne MUST jamais servir de réponse à une question ou à une demande d'autorisation.
- **FR-015**: « Renvoyer à l'agent » MUST envoyer la demande écrite dans la colonne Décision comme
  consigne et revenir aux tuiles.

**Colonne Décision**

- **FR-016**: La colonne Décision MUST afficher l'état des tests (réussis, en échec, en cours, non
  lancés, non configurés), la présence ou non de conflits avec la branche principale, le nombre de
  fichiers non vus et l'état de l'agent.
- **FR-017**: Le système MUST lancer la commande de test du dépôt dans le worktree de l'agent à
  l'ouverture de la revue quand aucun résultat ne correspond à l'état actuel des changements, et à
  la demande ; la commande MUST être détectée depuis le dépôt quand c'est possible et modifiable
  par l'utilisateur pour le workspace.
- **FR-018**: L'absence de conflit avec la branche principale MUST être vérifiée sans modifier la
  branche principale, le dossier de travail du dépôt principal ni le worktree de l'agent, et mise à
  jour quand l'une ou l'autre branche change.

**Intégration**

- **FR-019**: « ✓ Intégrer » MUST proposer le mode squash (un seul commit) par défaut et le mode
  « garder les commits » dans le menu ▾, avec un message de commit proposé et modifiable.
- **FR-020**: L'intégration MUST porter sur la branche principale locale du dépôt ; elle ne MUST
  jamais pousser vers un dépôt distant.
- **FR-021**: Avant toute modification, l'intégration MUST être refusée si le dépôt principal a des
  changements non commités sur des fichiers qu'elle toucherait, avec la liste de ces fichiers.
- **FR-022**: Si la branche principale est extraite dans le dépôt principal, son dossier de travail
  MUST refléter l'intégration ; sinon, seule la branche MUST changer, sans changer la branche
  extraite.
- **FR-023**: Le commit d'intégration MUST passer par les crochets Git du dépôt (`pre-commit`,
  `commit-msg`). Une intégration qui échoue, y compris sur le refus d'un crochet, MUST laisser la
  branche principale et son dossier de travail dans leur état d'avant et afficher l'erreur.
- **FR-024**: Les cases « Fermer la tuile » et « Supprimer worktree et branche », cochées par défaut,
  MUST régler le sort de l'agent après une intégration réussie ; « Conserver le worktree » MUST
  garder l'agent ouvert, prêt pour une nouvelle tâche.
- **FR-025**: L'intégration d'un agent qui travaille encore MUST demander confirmation.
- **FR-026**: Deux intégrations du même workspace MUST se faire l'une après l'autre.

**Conflits**

- **FR-027**: Si l'intégration rencontre un conflit, le système MUST ouvrir l'écran de conflit sans
  avoir modifié la branche principale : onglet « Conflits · N », fichiers en conflit et sans
  conflit, et pour chaque conflit les deux versions avec le commit de la branche principale qui l'a
  introduit.
- **FR-028**: L'écran de conflit MUST recommander « Demander à l'agent », qui tape dans son invite une
  consigne de mise à jour depuis la branche principale, de résolution et de relance des tests.
- **FR-029**: Chaque conflit MUST pouvoir être résolu par « Garder main », « Garder cette version »,
  « Les deux » ou « Modifier… » (édition dans PACT ou ouverture dans l'éditeur de l'utilisateur),
  avec un compteur « N / M résolu ».
- **FR-030**: « Terminer l'intégration » MUST rester inactif tant qu'un conflit n'est pas résolu.
- **FR-031**: « Annuler l'intégration » MUST abandonner les résolutions et remettre le worktree de
  l'agent dans son état d'avant, la branche principale n'ayant pas bougé.

**Abandon**

- **FR-032**: « ✕ Abandonner » MUST demander confirmation, n'intégrer aucun changement, puis poser
  la question de la fermeture d'un agent (garder ou supprimer worktree et branche, FR-037 de 001).

**Plateformes**

- **FR-033**: Revue, intégration et conflits MUST fonctionner à l'identique sur macOS et Windows, y
  compris avec des chemins contenant espaces et accents et sans différence due aux fins de ligne.

### Key Entities

- **Revue** : les changements d'un agent par rapport à la branche principale à un instant donné ;
  liste de fichiers, totaux, état des tests et des conflits ; appartient à un agent.
- **Fichier changé** : chemin (et ancien chemin s'il est renommé), type de changement, lignes
  ajoutées et retirées, binaire ou non, état « vu » lié à son contenu.
- **Commentaire** : fichier, ligne, texte, date, traité ou non (repris par « Corriger les
  commentaires »).
- **Résultat de tests** : commande, état, résumé de la sortie, état des changements auquel il
  correspond.
- **Intégration** : agent, mode (squash ou garder les commits), message, sort de l'agent après
  coup, état (en cours, en conflit, réussie, annulée, échouée).
- **Conflit** : fichier, zone, version de la branche principale (avec son commit), version de
  l'agent, résolution choisie.
- **Commande de test du workspace** : détectée ou saisie, propre au workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Pour un agent qui a modifié jusqu'à 50 fichiers, l'onglet Changements affiche la liste
  et le premier diff en moins de 2 secondes après le clic sur « Revue → ».
- **SC-002**: Un utilisateur intègre le travail d'un agent sans conflit en moins de 30 secondes et
  3 clics à partir de « Revue → », sans quitter PACT.
- **SC-003**: Dans 100 % des intégrations annulées, échouées ou bloquées par un conflit, la branche
  principale et le dossier de travail du dépôt principal sont identiques à leur état d'avant.
- **SC-004**: Un commentaire sur une ligne arrive dans l'invite de l'agent en moins de 1 seconde
  quand l'agent est prêt, avec le fichier et la ligne exacts.
- **SC-005**: Un conflit sur un fichier se résout depuis PACT (par l'agent ou à la main) sans ouvrir
  de terminal ni d'autre outil Git.
- **SC-006**: Une modification du worktree de l'agent apparaît dans la revue ouverte en moins de 3
  secondes.
- **SC-007**: L'ensemble des scénarios d'acceptation passe à l'identique sur macOS et sur Windows.

## Assumptions

- La branche principale est celle du dépôt principal identifiée par le socle (celle d'où partent les
  worktrees des agents) ; elle est locale.
- La commande de test par défaut est déduite du dépôt (par exemple le script `test` d'un projet
  Node) ; sans commande détectée, l'utilisateur en saisit une ou la ligne Tests reste « non
  configurés ». Des tests en échec n'empêchent pas d'intégrer : l'utilisateur décide.
- « Squash » est le mode par défaut (décision des maquettes : « Intégration : squash par défaut ») ;
  le message proposé reprend la consigne de l'agent.
- L'agent n'a pas à commiter : ses changements non commités font partie de la revue et de
  l'intégration.
- Les commentaires de revue restent locaux à PACT ; ils ne sont pas écrits dans le dépôt.
- « Ouvrir dans l'éditeur » utilise l'application associée aux fichiers par le système, ou l'éditeur
  configuré dans Git s'il y en a un.
- Le sort de la version non gardée et la comparaison d'aperçus attendent la spec Aperçus ; pousser
  et ouvrir une pull request attendent la spec Workflows.
- Usage mono-utilisateur, en local, comme le socle.
