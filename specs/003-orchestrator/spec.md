# Feature Specification: Orchestrateur

**Feature Branch**: `003-orchestrator`

**Created**: 2026-10-31

**Status**: Draft

**Input**: User description: "Orchestrateur pour PACT (spec 003, suite de 001-agent-workspace-core
et 002-review-integration) : un agent Claude Code désigné « Orchestrateur » au lancement (option
dans « Ajouter des agents ») devient chef d'équipe. PACT l'affiche en grand au centre, les autres
agents du workspace en tuiles en dessous. PACT installe pour lui un skill qui lui permet, via un
accès local sécurisé (127.0.0.1 + jeton, comme les hooks) : d'envoyer des consignes aux autres
agents PACT (même file d'attente que les commentaires de revue, jamais pendant une question en
attente), de lire leur état et leurs changements (diff, tests, conflits), de lancer et fermer des
agents (CLI, branche), et de demander l'intégration du travail d'un agent dans main — chaque
intégration demandée par l'orchestrateur devant être confirmée par l'utilisateur dans PACT. Les
autres agents sont des agents PACT (chacun son CLI, son worktree, sa branche), pas des coéquipiers
Claude Code. macOS et Windows."

## Références UI

Pas d'écran de référence dans `docs/maquettes/` pour ce lot. La disposition reprend les tuiles du
socle (1c) et le Focus (1p) : l'orchestrateur occupe une grande tuile en haut, au centre, les autres
agents une rangée de tuiles en dessous. Apparence : `docs/maquettes/Maquette interactive.dc.html`
(research.md R17 de 001). Libellés courts, abrégés par une icône avec légende :
`docs/maquettes/CONSIGNES-UI.md`.

## Périmètre

**Inclus** : option « Orchestrateur » au lancement d'un agent Claude Code, disposition « chef au
centre », skill installé pour l'orchestrateur, accès local réservé à l'orchestrateur, consignes aux
autres agents, lecture de leur état et de leurs changements, attente d'un changement d'état,
lancement et fermeture d'agents, demande d'intégration confirmée par l'utilisateur, trace des
actions de l'orchestrateur dans PACT, retrait du rôle.

**Hors périmètre** :

- Coéquipiers Claude Code (équipes d'agents natives) : ils restent dans le terminal de leur agent,
  sans tuile propre ; activés pour tous les agents Claude Code depuis la PR #20.
- Orchestrateur sous un autre CLI que Claude Code (Codex, CLI ajoutés) : le skill est propre à Claude
  Code.
- Plusieurs orchestrateurs dans un même workspace, ou un orchestrateur qui dirige plusieurs
  workspaces.
- Suppression d'un worktree ou d'une branche par l'orchestrateur, pousser vers un dépôt distant,
  ouvrir une pull request (spec Workflows).
- Réponse aux questions et autorisations des autres agents par l'orchestrateur : elles restent à
  l'utilisateur.
- Workflows enregistrés et réutilisables (spec Workflows).

## Clarifications

### Session 2026-10-31

- Q: Qui l'orchestrateur dirige-t-il ? → A: les agents PACT du workspace (chacun son CLI, son
  worktree, sa branche), pas des coéquipiers Claude Code.
- Q: Que peut-il faire sur eux ? → A: envoyer des consignes, lire leur état et leurs changements,
  lancer et fermer des agents, demander une intégration dans la branche principale.
- Q: Comment est-il désigné ? → A: au lancement, par une option « Orchestrateur » sur un agent Claude
  Code.
- Q: Une intégration demandée par l'orchestrateur se fait-elle seule ? → A: non, l'utilisateur la
  confirme dans PACT ; la branche principale ne bouge jamais sans clic humain.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Lancer un orchestrateur qui dirige les autres agents (Priority: P1)

L'utilisateur ouvre « Ajouter des agents » et coche « Orchestrateur » sur un agent Claude Code, à
côté de deux agents Codex et d'un autre Claude Code. Après le lancement, l'orchestrateur occupe une
grande tuile en haut, au centre, marquée « ◎ Orchestrateur » ; les trois autres sont en rangée en
dessous. L'utilisateur tape dans le terminal de l'orchestrateur : « Fais refactorer l'auth par
Codex 1 et écrire les tests par Codex 2, puis vérifie leur travail ». L'orchestrateur envoie une
consigne à chacun ; elles apparaissent dans leurs invites, avec la mention « ◎ de l'orchestrateur »
sur leur tuile.

**Why this priority**: c'est le cœur de la fonctionnalité : un agent qui en dirige d'autres, sans
que l'utilisateur recopie les consignes d'un terminal à l'autre.

**Independent Test**: lancer un orchestrateur (faux CLI) et deux agents ; faire envoyer par
l'orchestrateur une consigne à chacun ; vérifier qu'elles arrivent dans les invites des deux agents,
seulement quand ils sont prêts, et que les tuiles l'indiquent.

**Acceptance Scenarios**:

1. **Given** le lanceur ouvert avec un agent Claude Code, **When** l'utilisateur coche
   « Orchestrateur » sur cet agent et lance, **Then** l'agent démarre comme orchestrateur, avec son
   skill disponible dès sa première consigne.
2. **Given** un orchestrateur et trois autres agents, **When** l'utilisateur regarde les tuiles,
   **Then** l'orchestrateur occupe la grande tuile du haut, au centre, et les autres sont en dessous,
   dans leur ordre habituel.
3. **Given** un agent prêt à recevoir une consigne, **When** l'orchestrateur lui en envoie une,
   **Then** elle arrive dans son invite et sa tuile indique qu'elle vient de l'orchestrateur.
4. **Given** un agent qui travaille ou qui attend une réponse de l'utilisateur, **When**
   l'orchestrateur lui envoie une consigne, **Then** elle attend son tour et n'est jamais tapée comme
   réponse à une question ou à une autorisation.
5. **Given** un orchestrateur, **When** il demande la liste des agents, **Then** il obtient pour
   chacun son nom, son CLI, sa branche, son état et s'il a des changements à relire, sans lui-même.

---

### User Story 2 - Suivre le travail des agents sans intervenir (Priority: P1)

L'orchestrateur a donné ses consignes. Il attend que l'un des agents finisse, sans interroger PACT en
boucle. Quand Codex 1 a terminé, il lit ses changements (fichiers, diff, état des tests, conflits avec
la branche principale), juge le résultat et renvoie une consigne de correction, ou passe à l'agent
suivant.

**Why this priority**: diriger sans pouvoir vérifier ne sert à rien ; et sans attente, l'orchestrateur
gaspillerait son contexte à demander l'état en boucle.

**Independent Test**: faire produire des changements à un agent (faux CLI), puis vérifier que
l'orchestrateur, en attente, est réveillé à la fin du tour de l'agent et lit les mêmes fichiers, diff,
tests et conflits que la revue de 002.

**Acceptance Scenarios**:

1. **Given** des agents au travail, **When** l'orchestrateur attend un changement d'état, **Then** il
   est réveillé dès qu'un agent finit son tour, attend une réponse, tombe en erreur ou est fermé, avec
   l'agent et son nouvel état.
2. **Given** aucun changement pendant le délai d'attente choisi, **When** le délai expire, **Then**
   l'orchestrateur est réveillé avec « aucun changement », sans erreur.
3. **Given** un agent avec des changements, **When** l'orchestrateur les lit, **Then** il obtient la
   même liste de fichiers, les mêmes totaux et le même diff que l'onglet Changements, et l'état des
   tests et des conflits de la colonne Décision.
4. **Given** un agent qui attend une réponse de l'utilisateur, **When** l'orchestrateur lit son état,
   **Then** il apprend qu'une question attend l'utilisateur, avec son résumé, mais ne peut pas y
   répondre.

---

### User Story 3 - Faire intégrer le travail d'un agent, avec l'accord de l'utilisateur (Priority: P2)

L'orchestrateur juge le travail de Codex 1 prêt. Il demande son intégration dans la branche
principale, avec un message de commit. PACT ne fait rien seul : la colonne À faire affiche
« ◎ Intégrer Codex 1 → main ? », avec le message proposé et « Revue → ». L'utilisateur relit, puis
confirme ou refuse. L'orchestrateur apprend le résultat : intégré, refusé par l'utilisateur, ou
arrêté sur un conflit.

**Why this priority**: c'est le dernier pas de la boucle ; mais la branche principale est le bien de
l'utilisateur, d'où la confirmation obligatoire.

**Independent Test**: faire demander par l'orchestrateur l'intégration d'un agent ; vérifier que la
branche principale ne bouge pas tant que l'utilisateur n'a pas confirmé, puis qu'elle reçoit le
commit après confirmation et que l'orchestrateur en est informé.

**Acceptance Scenarios**:

1. **Given** un agent avec des changements, **When** l'orchestrateur demande son intégration, **Then**
   À faire affiche la demande avec l'agent, le mode (squash par défaut) et le message proposé, et la
   branche principale ne change pas.
2. **Given** une demande affichée, **When** l'utilisateur confirme, **Then** l'intégration se fait
   comme si l'utilisateur avait cliqué « ✓ Intégrer » (FR-019 à FR-026 de 002), et l'orchestrateur
   reçoit « intégré » avec le commit.
3. **Given** une demande affichée, **When** l'utilisateur refuse, **Then** rien n'est intégré et
   l'orchestrateur reçoit « refusé par l'utilisateur ».
4. **Given** une intégration confirmée qui rencontre un conflit, **When** l'écran de conflit s'ouvre,
   **Then** l'orchestrateur reçoit « conflit » avec les fichiers concernés, et peut demander à l'agent
   de résoudre (consigne « Conflit avec main » de 002).
5. **Given** une demande en attente de l'utilisateur, **When** l'orchestrateur en fait une seconde
   pour le même agent, **Then** la seconde remplace la première, sans doublon dans À faire.

---

### User Story 4 - Lancer et fermer des agents depuis l'orchestrateur (Priority: P3)

L'orchestrateur découpe un travail en trois parties et n'a que deux agents. Il demande un nouvel
agent Codex sur une branche qu'il nomme. PACT le lance comme le lanceur l'aurait fait (worktree,
port, couleur, niveau d'autorisation du workspace) et sa tuile rejoint la rangée. Plus tard,
l'orchestrateur ferme un agent dont le travail a été intégré ; son worktree et sa branche sont
conservés.

**Why this priority**: utile pour des tâches longues, mais l'utilisateur peut toujours lancer les
agents lui-même avant de donner la consigne à l'orchestrateur.

**Independent Test**: faire lancer par l'orchestrateur un agent (faux CLI) avec une branche donnée,
vérifier sa tuile, son worktree et sa branche ; le faire fermer, vérifier que la tuile disparaît et
que le worktree et la branche restent.

**Acceptance Scenarios**:

1. **Given** un workspace avec moins de 6 agents, **When** l'orchestrateur lance un agent avec un CLI
   installé et, au choix, un modèle, une branche et une consigne initiale, **Then** l'agent démarre
   comme depuis le lanceur, et l'orchestrateur reçoit son identifiant.
2. **Given** un workspace avec 6 agents, ou un CLI absent, ou une branche qui existe déjà, **When**
   l'orchestrateur lance un agent, **Then** la demande est refusée avec la même raison que dans le
   lanceur, et rien n'est créé.
3. **Given** un agent lancé, **When** l'orchestrateur le ferme, **Then** l'agent s'arrête et sa tuile
   disparaît, son worktree et sa branche restent ; seul l'utilisateur peut les supprimer.
4. **Given** l'orchestrateur, **When** il tente de se fermer lui-même ou de fermer un terminal libre,
   **Then** la demande est refusée.

---

### User Story 5 - Garder la main sur l'orchestrateur (Priority: P3)

L'utilisateur veut savoir ce que l'orchestrateur a fait et pouvoir l'arrêter. Le Focus de
l'orchestrateur propose un journal « ◎ Actions » : consignes envoyées, agents lancés ou fermés,
demandes d'intégration, avec l'heure. L'utilisateur peut retirer le rôle à tout moment : l'agent
continue comme un agent ordinaire et perd l'accès aux autres agents.

**Why this priority**: indispensable à la confiance, mais les consignes restent visibles dans les
terminaux des agents dès US1.

**Independent Test**: faire agir l'orchestrateur, vérifier le journal ; retirer le rôle, vérifier que
toute demande suivante de l'orchestrateur est refusée et que la disposition revient à la grille.

**Acceptance Scenarios**:

1. **Given** un orchestrateur qui a agi, **When** l'utilisateur ouvre son Focus, **Then** le journal
   liste chaque action, la plus récente en premier, avec l'agent visé et le résultat.
2. **Given** un orchestrateur, **When** l'utilisateur choisit « Retirer le rôle d'orchestrateur »,
   **Then** ses demandes suivantes sont refusées, ses consignes déjà en file sont annulées, et les
   tuiles reviennent à la grille du socle.
3. **Given** un workspace avec un orchestrateur, **When** l'utilisateur rouvre PACT, **Then**
   l'orchestrateur revient avec son rôle et son accès, et ses demandes d'intégration non confirmées
   sont reproposées.

---

### Edge Cases

- L'orchestrateur envoie une consigne à un agent fermé, en erreur ou inconnu : refusée avec la raison ;
  un agent en erreur garde ses actions « Reprendre » / « Relancer », réservées à l'utilisateur.
- Plusieurs consignes de l'orchestrateur pour un même agent : elles passent une par tour, dans l'ordre,
  avec les commentaires de revue de l'utilisateur dans la même file.
- L'utilisateur tape lui-même dans le terminal d'un agent pendant qu'une consigne de l'orchestrateur
  attend : la file reste ; la consigne passe au prochain tour terminé.
- L'orchestrateur lui-même attend une réponse (autorisation) : ses demandes déjà faites continuent ;
  sa question apparaît dans À faire comme pour tout agent.
- L'orchestrateur est fermé, plante ou atteint une limite de débit : les agents continuent ; ses
  demandes d'intégration en attente restent proposées à l'utilisateur ; les consignes en file restent.
- Un autre agent tente d'utiliser l'accès de l'orchestrateur (par exemple en lisant ses variables) :
  l'accès est propre à l'orchestrateur et à sa session ; il est refusé à tout autre processus qui n'a
  pas son secret, et renouvelé à chaque démarrage.
- Consigne très longue ou sur plusieurs lignes : envoyée d'un bloc, comme les consignes de revue ;
  au-delà de la taille maximale, refusée.
- Le workspace devient indisponible (dossier disparu) : les demandes de l'orchestrateur sont refusées
  jusqu'au retour du dossier.
- Chemins avec espaces et accents, sur macOS et Windows, dans les changements lus par l'orchestrateur.

## Requirements *(mandatory)*

### Functional Requirements

**Désignation et disposition**

- **FR-001**: Le lanceur (modes rapide et détaillé) MUST proposer « Orchestrateur » sur un agent Claude
  Code, pour un seul agent par workspace ; l'option MUST être absente pour les autres CLI et inactive
  quand le workspace a déjà un orchestrateur.
- **FR-002**: L'orchestrateur MUST compter dans la limite de 6 agents et avoir, comme tout agent, son
  worktree, sa branche, son port et sa couleur.
- **FR-003**: Quand un orchestrateur existe, la vue Tuiles MUST l'afficher dans une grande tuile en
  haut, au centre, marquée « ◎ Orchestrateur », et les autres agents et terminaux libres en dessous ;
  sans orchestrateur, la grille du socle s'applique.
- **FR-004**: L'utilisateur MUST pouvoir retirer le rôle à tout moment ; l'agent continue comme agent
  ordinaire et son accès aux autres agents est révoqué immédiatement.
- **FR-005**: Le rôle MUST être conservé après un redémarrage de PACT, avec un nouvel accès.

**Accès de l'orchestrateur**

- **FR-006**: PACT MUST mettre à disposition de l'orchestrateur, et de lui seul, un skill qui décrit
  ses actions et les rend utilisables dès sa première consigne, sans configuration par l'utilisateur.
- **FR-007**: L'accès MUST être local à la machine et réservé à l'orchestrateur par un secret propre à
  sa session ; toute demande sans ce secret, ou après retrait du rôle, MUST être refusée.
- **FR-008**: L'orchestrateur MUST ne pouvoir agir que sur les agents de son workspace, jamais sur
  lui-même, sur les terminaux libres ni sur d'autres workspaces.

**Consignes**

- **FR-009**: L'orchestrateur MUST pouvoir envoyer une consigne à un agent ; elle MUST passer par la
  même file que les consignes de la revue (002 FR-014) : tapée quand l'agent est prêt, jamais comme
  réponse à une question ou à une autorisation.
- **FR-010**: Une consigne de l'orchestrateur MUST être signalée sur la tuile et dans le Focus de
  l'agent qui la reçoit (« ◎ de l'orchestrateur »), jusqu'à la fin du tour qu'elle a lancé.

**Lecture et attente**

- **FR-011**: L'orchestrateur MUST pouvoir lister les agents du workspace avec, pour chacun : nom,
  CLI, branche, état, résumé de la question en attente le cas échéant, et présence de changements à
  relire.
- **FR-012**: L'orchestrateur MUST pouvoir lire les changements d'un agent : fichiers, totaux, diff
  d'un fichier, état des tests et des conflits, identiques à ceux de la revue (002 FR-005 à FR-018).
- **FR-013**: L'orchestrateur MUST pouvoir attendre le prochain changement d'état d'un agent ou de
  n'importe lequel, avec un délai maximal qu'il choisit ; l'attente MUST se terminer dès le changement,
  sans qu'il interroge PACT en boucle.
- **FR-014**: L'orchestrateur MUST pouvoir lancer la commande de test d'un agent et en lire le
  résultat (002 FR-017).

**Lancement et fermeture**

- **FR-015**: L'orchestrateur MUST pouvoir lancer un agent : CLI installé, et au choix modèle, branche,
  branche de départ et consigne initiale ; avec les mêmes validations et le même niveau d'autorisation
  que le lanceur pour ce workspace (001 FR-010 à FR-016).
- **FR-016**: L'orchestrateur MUST pouvoir fermer un agent ; le worktree et la branche MUST être
  conservés ; leur suppression MUST rester réservée à l'utilisateur.

**Intégration**

- **FR-017**: L'orchestrateur MUST pouvoir demander l'intégration d'un agent avec un mode (squash par
  défaut, ou garder les commits) et un message ; la demande MUST apparaître dans À faire et MUST
  attendre la décision de l'utilisateur, sans modifier la branche principale.
- **FR-018**: L'utilisateur MUST pouvoir confirmer (avec le message modifiable), refuser, ou ouvrir la
  revue de l'agent depuis la demande ; une confirmation MUST suivre le parcours d'intégration de 002.
- **FR-019**: L'orchestrateur MUST être informé de l'issue de chaque demande : intégré (avec le
  commit), refusé par l'utilisateur, arrêté sur un conflit (avec les fichiers), ou échoué (avec
  l'erreur).
- **FR-020**: Une nouvelle demande pour le même agent MUST remplacer la demande en attente.

**Traçabilité**

- **FR-021**: Le Focus de l'orchestrateur MUST proposer un journal de ses actions (consignes, lectures
  exclues, lancements, fermetures, demandes d'intégration et leur issue), le plus récent en premier,
  conservé pour la session de PACT.
- **FR-022**: Toute demande refusée MUST donner à l'orchestrateur une raison lisible.

**Plateformes**

- **FR-023**: Le rôle, la disposition, l'accès et le skill MUST fonctionner à l'identique sur macOS et
  Windows, chemins avec espaces et accents compris.

### Key Entities

- **Orchestrateur** : le rôle d'un agent Claude Code d'un workspace ; au plus un par workspace ;
  conservé avec l'agent ; porte un accès renouvelé à chaque démarrage.
- **Accès de l'orchestrateur** : le moyen local, réservé à l'orchestrateur, de demander les actions
  de cette spec ; révoqué au retrait du rôle ou à la fermeture de l'agent.
- **Consigne de l'orchestrateur** : texte destiné à un agent, mis dans sa file de consignes ; marquée
  comme venant de l'orchestrateur.
- **Demande d'intégration** : agent, mode, message, état (en attente, confirmée, refusée, intégrée, en
  conflit, échouée) ; une seule en attente par agent.
- **Action de l'orchestrateur** : entrée du journal : heure, type, agent visé, résultat.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Une consigne envoyée par l'orchestrateur à un agent prêt arrive dans son invite en moins
  de 1 seconde.
- **SC-002**: L'orchestrateur en attente est réveillé moins de 2 secondes après la fin du tour d'un
  agent.
- **SC-003**: Dans 100 % des cas, la branche principale ne reçoit le travail d'un agent demandé par
  l'orchestrateur qu'après une confirmation de l'utilisateur.
- **SC-004**: Dans 100 % des tentatives, une demande sans le secret de l'orchestrateur, ou après
  retrait du rôle, est refusée sans effet.
- **SC-005**: Un utilisateur fait réaliser par l'orchestrateur une tâche répartie sur deux agents,
  jusqu'à la demande d'intégration, sans taper lui-même de consigne dans le terminal d'un autre agent.
- **SC-006**: L'ensemble des scénarios d'acceptation passe à l'identique sur macOS et sur Windows.

## Assumptions

- L'orchestrateur est un agent Claude Code 2.1 ou plus récent : les skills sont une fonctionnalité de
  Claude Code ; PACT les fournit pour la session de l'orchestrateur sans modifier la configuration
  personnelle de l'utilisateur ni le dépôt.
- Le niveau d'autorisation des agents lancés par l'orchestrateur est celui du workspace (ou le choix
  global), comme pour un lancement rapide.
- Les questions et autorisations des agents restent à l'utilisateur : l'orchestrateur les voit mais
  n'y répond pas.
- Le journal des actions est conservé pour la session de PACT ; il n'est pas écrit dans le dépôt.
- Les demandes d'intégration en attente sont conservées avec le workspace, pour être reproposées
  après un redémarrage.
- Usage mono-utilisateur, en local, comme le socle.
