# Feature Specification: Chaîne de livraison

**Feature Branch**: `004-delivery-chain`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Feature 004 « Chaîne de livraison » (suite de 003-orchestrator) : adapter
PACT au workflow de l'utilisateur avec une chaîne pro orchestrateur → spec → maquettes → dev → test →
recap. Suite de skills au format Agent Skills compatible avec tous les CLI (repli AGENTS.md), injectée
à chaque lancement sans toucher la configuration globale : pact-orchestrator, pact-spec,
pact-design-system, pact-mockup, pact-dev, pact-test, pact-recap, plus un contrat de relais commun ;
délégation à spec-kit quand le dépôt l'utilise. Rôles et profils de modèles par rôle (CLI + modèle +
effort), plafonnés, avec escalade optionnelle. Boucle dev ↔ test plafonnée à 3 tours, preuve par codes
de sortie, escalade à l'utilisateur, questions remontées, agents en parallèle sans fichiers communs,
traçabilité issue → branche → PR → recap. Panneau navigateur interne pour les maquettes et le recap.
Orchestrateur possible sous d'autres CLI qui gèrent MCP. Hors périmètre : jauge de limite d'usage
(005), push ou PR sans confirmation. macOS et Windows."

## Références UI

Pas de maquette dédiée dans `docs/maquettes/` pour ce lot. Les écrans reprennent ceux du socle et de
003 : lanceur (1c, 1d), tuiles et Focus (1p), colonne À faire, disposition « chef au centre » de 003.
Le panneau d'aperçu prend la place de l'onglet « Aperçu » du Focus (001 FR-033, grisé jusqu'ici).
Apparence : `docs/maquettes/Maquette interactive.dc.html` (research.md R17 de 001). Libellés :
`docs/maquettes/CONSIGNES-UI.md`.

## Périmètre

**Inclus** : rôles d'agent et profils de modèles par rôle, réglés par workspace ; suite de skills par
rôle, livrée par PACT à chaque agent selon son rôle, pour tout CLI ; contrat de relais (rapport
structuré de fin de tour) ; boucle dev ↔ test plafonnée et suivie par PACT ; preuve de « fait » par
les commandes de test lancées par PACT ; escalade à l'utilisateur dans À faire ; détection des
fichiers communs entre agents en parallèle ; cadrage (spec et issues) avec délégation à spec-kit ;
design system et maquettes ; onglet Aperçu du Focus pour les maquettes et le recap, avec validation
renvoyée à l'orchestrateur ; recap tenu à jour ; orchestrateur sous un autre CLI qui gère MCP.

**Hors périmètre** :

- Jauge de limite d'usage des CLI (spec 005).
- Pousser vers un dépôt distant ou ouvrir une pull request sans confirmation de l'utilisateur.
- Aperçu d'un serveur de développement lancé par un agent (vue Comparer, A/B, 001 hors périmètre).
- Réponse aux questions et autorisations des agents par l'orchestrateur (elles restent à
  l'utilisateur, 003).
- Bibliothèque de workflows enregistrés et éditeur de skills dans PACT.
- Plus de 6 agents par workspace.

## Clarifications

### Session 2026-11-03

Décisions prises avec l'utilisateur pendant la conversation de cadrage :

- Q: Les sous-agents sont-ils des sous-agents natifs du CLI ou des agents PACT ? → A: des agents
  PACT (chacun son worktree, sa branche, son terminal), lancés par l'orchestrateur.
- Q: Un seul gros skill ou plusieurs ? → A: une suite de skills, un par rôle, plus un contrat commun ;
  l'orchestrateur ne fait que coordonner.
- Q: Maquettes sur claude.ai ou en local ? → A: en local, mais à partir d'un design system de
  l'application, que le skill crée s'il n'existe pas, puis utilise ; universel entre CLI.
- Q: Modèles ? → A: paramétrables par rôle (orchestrateur et agents), modèle moins cher pour le dev.
- Q: spec-kit ? → A: oui, le skill de cadrage s'appuie sur les skills spec-kit quand le dépôt les a.
- Q: Comment repérer l'orchestrateur ? → A: sa tuile est toujours plus grande que celles des
  sous-agents, et ses rapports s'y lisent facilement.
- Q: Pratiques retenues ? → A: Definition of Ready / Done, tests d'acceptation écrits d'abord (ATDD),
  testeur indépendant, rapport de relais structuré, traçabilité, preuve par la CI, escalade, budgets
  (3 tours), pas de fichiers communs en parallèle, recap versionné.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Lancer des agents par rôle, avec le bon modèle (Priority: P1)

L'utilisateur a réglé les profils de son workspace : orchestrateur et test sur Claude avec un modèle
fort, dev sur Codex avec un modèle moyen, recap sur un petit modèle. Il lance un orchestrateur et lui
demande de traiter une issue. L'orchestrateur demande un agent « dev » puis un agent « test ». PACT les
lance avec le CLI, le modèle et l'effort du profil de leur rôle, leur donne les skills de ce rôle, et
leurs tuiles affichent leur rôle (« dev », « test »). Quand l'orchestrateur demande un modèle plus fort
que celui que le profil autorise, PACT refuse et lui donne la raison.

**Why this priority**: sans rôles ni profils, la chaîne n'existe pas ; c'est aussi ce qui permet de
payer moins cher le développement.

**Independent Test**: régler des profils, faire lancer par un faux orchestrateur un agent « dev » et
un agent « test » ; vérifier CLI, modèle, effort, skills reçus et libellé des tuiles ; vérifier le
refus d'un modèle au-delà du plafond.

**Acceptance Scenarios**:

1. **Given** un workspace sans réglage, **When** l'utilisateur ouvre les profils, **Then** chaque rôle
   (orchestrateur, spec, design, dev, test, recap) a un profil par défaut : modèle fort pour
   orchestrateur, spec et design, moyen pour dev, au moins celui du dev pour test, petit pour recap.
2. **Given** des profils réglés, **When** l'orchestrateur lance un agent avec un rôle, **Then** l'agent
   démarre avec le CLI, le modèle et l'effort de ce profil, et sa tuile affiche son rôle.
3. **Given** un profil dont le plafond est le modèle moyen, **When** l'orchestrateur demande un modèle
   plus fort pour ce rôle, **Then** la demande est refusée avec la raison, et rien n'est lancé.
4. **Given** le lanceur, **When** l'utilisateur lance lui-même un agent et choisit un rôle, **Then** le
   profil de ce rôle pré-remplit CLI, modèle et effort, qu'il peut changer pour ce lancement seulement.
5. **Given** un profil de test réglé sur un modèle plus faible que celui du dev, **When** l'utilisateur
   l'enregistre, **Then** PACT l'avertit que le testeur doit être au moins aussi fort que le dev, sans
   l'en empêcher.

---

### User Story 2 - Boucle dev ↔ test plafonnée, prouvée par les tests (Priority: P1)

L'orchestrateur confie une issue à un agent test, qui écrit d'abord les tests d'acceptation (en
échec), puis à un agent dev, qui les fait passer. À la fin de chaque tour, chaque agent rend un rapport
de relais : statut, fichiers touchés, commandes de test et leur code de sortie, questions ouvertes. Le
test relance les vérifications et rend un verdict : accepté, ou une liste de défauts renvoyée au dev.
PACT compte les tours de chaque issue. Au troisième échec, PACT arrête la boucle et met l'issue dans
À faire : « ✕ Boucle arrêtée · issue 12 · 3 tours », avec les rapports. Une issue n'est « faite » que
si PACT a lui-même lancé les tests et qu'ils ont renvoyé 0.

**Why this priority**: c'est la promesse de qualité de la chaîne : des agents qui se vérifient entre
eux, sans tourner sans fin ni se déclarer finis sur parole.

**Independent Test**: avec un faux CLI qui échoue toujours, vérifier l'arrêt au troisième tour et
l'élément À faire ; avec un faux CLI qui réussit au deuxième, vérifier l'état « faite » seulement après
une exécution des tests par PACT à 0.

**Acceptance Scenarios**:

1. **Given** un agent qui termine son tour, **When** il rend son rapport de relais, **Then** PACT le
   valide (champs obligatoires) et le transmet à l'orchestrateur ; un rapport invalide est refusé avec
   la raison, et l'agent peut le renvoyer.
2. **Given** une issue confiée, **When** le test rend un verdict « défauts », **Then** le tour suivant
   commence et PACT affiche « tour 2/3 » sur les tuiles des deux agents.
3. **Given** une issue au troisième verdict « défauts », **When** l'orchestrateur demande un quatrième
   tour, **Then** PACT refuse, et l'issue apparaît dans À faire avec ses trois rapports, en attente de
   l'utilisateur (relancer 3 tours, reprendre la main, abandonner).
4. **Given** un agent qui affirme « tests verts », **When** PACT lance la commande de test de son
   worktree et obtient un code différent de 0, **Then** l'issue n'est pas « faite », et l'orchestrateur
   reçoit le code et la fin de la sortie.
5. **Given** l'escalade de modèle activée dans le profil dev, **When** le deuxième tour échoue, **Then**
   le troisième tour du dev se fait avec le modèle supérieur autorisé par son profil, et le journal de
   l'orchestrateur l'indique.
6. **Given** un agent test, **When** son tour modifie un fichier hors des tests (code de production),
   **Then** PACT rejette son verdict et le signale à l'orchestrateur.

---

### User Story 3 - Cadrer : de la demande aux issues prêtes (Priority: P2)

L'utilisateur tape `/pact-orchestrator` puis décrit ce qu'il veut. L'orchestrateur (ou un agent
« spec ») lui pose ses questions, puis rédige la spec et la découpe en issues, chacune avec ses
critères d'acceptation Given/When/Then. Dans un dépôt qui utilise spec-kit, il passe par les skills
spec-kit (specify, clarify, plan, tasks, analyze, taskstoissues). Avant de créer les issues sur
GitHub, il les montre ; l'utilisateur confirme dans À faire. Une issue ne part en dev que si elle est
« prête » (critères d'acceptation présents, questions résolues).

**Why this priority**: la qualité du code dépend de celle des consignes ; mais l'utilisateur peut
aussi donner une issue déjà écrite.

**Independent Test**: avec un faux orchestrateur, proposer des issues ; vérifier qu'aucune n'est créée
sur le dépôt distant avant la confirmation ; vérifier le refus de lancer un dev sur une issue sans
critères d'acceptation.

**Acceptance Scenarios**:

1. **Given** un dépôt avec spec-kit, **When** l'orchestrateur cadre une demande, **Then** son skill de
   cadrage lui indique d'utiliser les skills spec-kit du dépôt, dans l'ordre du dépôt.
2. **Given** un dépôt sans spec-kit, **When** l'orchestrateur cadre, **Then** il produit des issues au
   format léger : titre, contexte, critères Given/When/Then, fichiers probables, hors périmètre.
3. **Given** des issues proposées, **When** l'orchestrateur demande leur création sur le dépôt distant,
   **Then** À faire affiche « ◎ Créer 4 issues ? » avec leur titre ; rien n'est publié avant
   confirmation ; sans dépôt distant ou sans outil GitHub, elles restent en fichiers locaux.
4. **Given** une issue sans critères d'acceptation, **When** l'orchestrateur la confie à un dev,
   **Then** PACT refuse avec « issue non prête ».

---

### User Story 4 - Design system et maquettes validées avant le code (Priority: P2)

Pour une issue avec de l'interface, l'orchestrateur lance un agent « design ». Celui-ci cherche le
design system de l'application ; s'il n'en trouve pas, il en crée un à partir de l'application
existante (couleurs, typographie, espacements, composants) et le fait valider. Il produit ensuite des
maquettes HTML statiques qui n'utilisent que ce design system. L'utilisateur les ouvre dans l'onglet
« Aperçu » du Focus de l'agent, sans réseau, et clique « ✓ Valider » ou « ✕ Refuser » avec un
commentaire ; l'orchestrateur reçoit la décision.

**Why this priority**: valider l'interface avant le code évite des tours de dev inutiles ; mais la
chaîne fonctionne sans pour une issue sans interface.

**Independent Test**: faire écrire par un faux agent un design system et une maquette dans son
worktree ; l'ouvrir dans l'Aperçu ; vérifier qu'aucune requête réseau ne part, puis que la validation
et le commentaire arrivent à l'orchestrateur.

**Acceptance Scenarios**:

1. **Given** un dépôt sans design system, **When** l'agent design commence, **Then** son skill lui fait
   créer les jetons de design, une feuille de style générée et un guide, puis demander la validation
   de l'utilisateur avant toute maquette.
2. **Given** un design system existant, **When** l'agent design fait une maquette, **Then** son skill
   lui interdit les valeurs en dur hors des jetons.
3. **Given** des maquettes dans le worktree d'un agent, **When** l'utilisateur ouvre l'onglet Aperçu,
   **Then** il voit la liste des maquettes et du recap, et la page choisie, sans aucune requête réseau
   ni script venu d'ailleurs.
4. **Given** une maquette affichée, **When** l'utilisateur clique « ✓ Valider » ou « ✕ Refuser » avec un
   commentaire, **Then** l'orchestrateur reçoit la décision, la maquette et le commentaire.

---

### User Story 5 - Recap : ce qui est fait et ce qu'il faut tester (Priority: P2)

Pendant tout le travail, un agent « recap » (ou l'orchestrateur) tient un recap court : pour chaque
issue, son état, l'agent et le modèle qui l'ont faite, la branche, le lien de la PR, les tours de
boucle, et surtout « À tester à la main » : les vérifications que l'utilisateur doit faire. Le recap
s'ouvre dans l'Aperçu du Focus de l'orchestrateur et se met à jour pendant que l'utilisateur le lit.

**Why this priority**: c'est ce que l'utilisateur lit en revenant ; mais chaque agent reste lisible
sans lui.

**Independent Test**: faire terminer deux issues par de faux agents ; vérifier que le recap liste les
deux avec leur trace (issue, branche, agent, tours) et une section « À tester à la main », et que
l'Aperçu se rafraîchit quand le fichier change.

**Acceptance Scenarios**:

1. **Given** une issue terminée, **When** l'orchestrateur la clôt, **Then** le recap gagne une entrée
   avec issue, branche, agent, rôle, modèle, nombre de tours, résultat des tests et PR s'il y en a une.
2. **Given** un recap ouvert dans l'Aperçu, **When** le fichier change, **Then** l'affichage se met à
   jour en moins de 2 secondes, sans perdre la position de lecture.
3. **Given** une issue terminée, **When** l'utilisateur lit le recap, **Then** il trouve une liste
   « À tester à la main » non vide pour cette issue, ou la mention explicite « rien à tester à la main ».

---

### User Story 6 - Les mêmes skills, quel que soit le CLI (Priority: P3)

L'utilisateur utilise Codex pour le dev et Claude Code pour le reste ; demain, peut-être un autre CLI.
Chaque agent reçoit les skills de son rôle sous une forme que son CLI lit : skills natifs quand le CLI
les gère, sinon un fichier d'instructions dans son worktree. L'orchestrateur peut aussi être un agent
Codex, dès lors que le CLI gère les outils MCP. Rien n'est écrit dans la configuration globale des CLI
de l'utilisateur.

**Why this priority**: l'universalité protège le travail de l'utilisateur des choix d'outils ; mais la
chaîne est utile dès qu'elle marche avec Claude Code.

**Independent Test**: lancer un agent dev sous un faux CLI « avec skills » et sous un faux CLI « sans
skills » ; vérifier qu'ils reçoivent le même contenu par les deux voies ; vérifier qu'aucun fichier de
configuration globale n'est modifié ; lancer un orchestrateur sous un faux CLI MCP non Claude.

**Acceptance Scenarios**:

1. **Given** un CLI qui lit les skills, **When** PACT lance un agent avec un rôle, **Then** les skills
   du rôle et le contrat commun lui sont fournis pour sa session seulement.
2. **Given** un CLI qui ne lit pas les skills, **When** PACT lance l'agent, **Then** le même contenu est
   fourni par un fichier d'instructions de son worktree, exclu des changements à relire et à intégrer.
3. **Given** un CLI qui gère MCP, **When** l'utilisateur coche « Orchestrateur » sur un agent de ce CLI,
   **Then** l'agent reçoit l'accès et les skills de l'orchestrateur comme sous Claude Code.
4. **Given** n'importe quel lancement, **When** PACT prépare l'agent, **Then** aucun fichier de
   configuration personnelle des CLI n'est créé ni modifié.

---

### Edge Cases

- Deux agents en parallèle modifient le même fichier : PACT le signale dès que les changements se
  recoupent, à l'orchestrateur (événement) et à l'utilisateur (À faire), avec les fichiers communs.
- Un agent ne rend pas de rapport à la fin de son tour : l'orchestrateur reçoit « rapport manquant » ;
  il peut le lui redemander ; ce tour compte dans le plafond.
- Un agent pose une question à l'utilisateur au milieu d'une boucle : la boucle attend ; la question
  est dans À faire ; l'orchestrateur en est informé (003) ; le temps passé ne consomme pas de tour.
- Le profil d'un rôle désigne un CLI désinstallé : le lancement est refusé avec la raison, et PACT
  propose le profil par défaut dans les réglages.
- Le modèle d'un profil n'existe plus côté CLI : l'agent tombe en erreur au démarrage, comme dans le
  socle ; l'orchestrateur reçoit l'erreur.
- L'utilisateur reprend la main sur une issue escaladée : la boucle est close ; les agents restent
  ouverts ; leur worktree et leur branche sont conservés.
- Une maquette référence une ressource externe (police, image, script) : elle n'est pas chargée ;
  l'Aperçu indique « ressource externe bloquée ».
- Le recap ou une maquette est très gros, ou n'est pas du HTML ou du Markdown valide : l'Aperçu
  affiche le texte brut, sans planter.
- Le dépôt a déjà son propre fichier d'instructions (un `AGENTS.md` de l'utilisateur) : PACT n'y touche
  pas ; il écrit ses instructions dans un fichier à lui, exclu de Git, et le retire à la fermeture de
  l'agent (research R3).
- L'orchestrateur est retiré de son rôle en pleine boucle : les boucles s'arrêtent, les agents
  continuent comme agents ordinaires ; le recap reste.
- Chemins avec espaces et accents, sur macOS et Windows, pour les skills, maquettes et recap.

## Requirements *(mandatory)*

### Functional Requirements

**Rôles et profils**

- **FR-001**: Le système MUST connaître six rôles d'agent : orchestrateur, spec, design, dev, test,
  recap ; un agent a au plus un rôle ; un agent lancé sans rôle reste un agent ordinaire.
- **FR-002**: Chaque workspace MUST avoir un profil par rôle : CLI, modèle, effort et modèle maximal
  autorisé ; avec des valeurs par défaut (fort pour orchestrateur, spec, design ; moyen pour dev ; au
  moins celui du dev pour test ; petit pour recap) quand l'utilisateur n'a rien réglé.
- **FR-003**: L'utilisateur MUST pouvoir modifier les profils d'un workspace, et choisir un rôle dans le
  lanceur ; le profil pré-remplit alors le lancement, modifiable pour ce lancement seulement.
- **FR-004**: Le système MUST avertir, sans bloquer, quand le profil test est plus faible que le profil
  dev.
- **FR-005**: L'orchestrateur MUST pouvoir lancer un agent avec un rôle (extension de 003 FR-015) ; le
  système MUST appliquer le profil du rôle et MUST refuser, avec la raison, tout modèle au-delà du
  maximal autorisé.
- **FR-006**: La tuile, le Focus et la liste des agents vue par l'orchestrateur MUST montrer le rôle de
  chaque agent.
- **FR-006a** *(demande de l'utilisateur, 2026-11-03)*: La tuile de l'orchestrateur MUST rester plus
  grande que celle de chaque autre agent du workspace, quel que soit leur nombre (jusqu'à 6) et la
  taille de la fenêtre, pour l'identifier d'un coup d'œil (extension de 003 FR-003) ; les rapports de
  relais qu'il reçoit MUST être lisibles depuis sa tuile et son Focus (dernier rapport par agent, avec
  issue, statut et tour), sans ouvrir le terminal d'un autre agent.
- **FR-007**: Quand l'escalade est activée dans un profil, le troisième tour d'une boucle MUST utiliser
  le modèle supérieur suivant, sans dépasser le maximal autorisé ; le journal de l'orchestrateur MUST
  l'indiquer.

**Skills par rôle**

- **FR-008**: PACT MUST fournir une suite de skills, un par rôle, plus un contrat commun (format du
  rapport de relais, règles de boucle, Definition of Ready, Definition of Done) que chaque skill
  référence.
- **FR-009**: Chaque agent lancé avec un rôle MUST recevoir le skill de son rôle et le contrat commun,
  et seulement ceux-là ; l'orchestrateur reçoit aussi les noms et rôles des autres skills.
- **FR-010**: Le skill de cadrage MUST, quand le dépôt utilise spec-kit, renvoyer aux skills spec-kit du
  dépôt (spécifier, clarifier, planifier, découper, analyser, publier les issues) ; le skill dev MUST
  alors renvoyer à l'implémentation spec-kit, et le skill test à la convergence spec-kit ; sinon, chaque
  skill MUST décrire son format léger.
- **FR-011**: Le skill test MUST imposer d'écrire les tests d'acceptation avant le dev, de ne jamais
  modifier le code de production, et de juger à partir du diff et de l'issue.
- **FR-012**: Le skill design MUST imposer de chercher un design system, d'en créer un (jetons, feuille
  de style dérivée, guide) s'il n'existe pas, de le faire valider avant toute maquette, et de n'utiliser
  que ses jetons dans les maquettes.
- **FR-013**: Les skills MUST être fournis sous forme de skills natifs aux CLI qui les lisent, et sous
  forme d'un fichier d'instructions du worktree aux autres ; le contenu MUST être le même.
- **FR-014**: Le système MUST NOT créer ni modifier de fichier de configuration personnelle des CLI ;
  les fichiers ajoutés au worktree MUST être exclus des changements à relire et à intégrer, et retirés
  à la fermeture de l'agent sans toucher au contenu que l'utilisateur y avait.

**Rapport de relais et boucle**

- **FR-015**: Un agent avec un rôle MUST pouvoir rendre un rapport de relais : issue, statut (fait,
  bloqué, défauts), fichiers touchés, commandes de test lancées avec leur code de sortie, questions
  ouvertes, et pour le test un verdict ; un rapport incomplet MUST être refusé avec la raison.
- **FR-016**: Le rapport MUST être transmis à l'orchestrateur comme un événement de son attente (003
  FR-013), et conservé avec la boucle de l'issue.
- **FR-017**: Le système MUST suivre, par issue, une boucle dev ↔ test : agents dev et test associés,
  numéro du tour, rapports ; et MUST afficher « tour N/3 » sur les tuiles des deux agents.
- **FR-018**: Le système MUST refuser un quatrième tour ; il MUST alors mettre l'issue dans À faire avec
  ses rapports, et proposer : relancer 3 tours, reprendre la main, abandonner.
- **FR-019**: Une issue MUST n'être « faite » qu'après une exécution, par PACT, de la commande de test
  du worktree concerné (002 FR-017) avec un code de sortie 0, postérieure au dernier changement ; une
  affirmation d'un agent seule MUST NOT suffire.
- **FR-020**: Le système MUST rejeter le verdict d'un agent test dont le tour a modifié des fichiers
  hors des tests, et le signaler à l'orchestrateur.
- **FR-021**: Le système MUST signaler à l'orchestrateur et dans À faire les fichiers modifiés par
  plusieurs agents du workspace dont le travail n'est pas encore intégré.
- **FR-022**: Une issue MUST NOT pouvoir être confiée à un agent dev si elle n'est pas « prête »
  (critères d'acceptation présents, aucune question ouverte).

**Cadrage et issues**

- **FR-023**: La publication d'issues sur le dépôt distant MUST passer par une demande dans À faire,
  confirmée par l'utilisateur ; sans confirmation, sans dépôt distant ou sans outil de publication,
  les issues MUST rester en fichiers locaux du worktree de l'orchestrateur.
- **FR-024**: Chaque issue MUST garder sa trace : identifiant, branche, agents, PR s'il y en a une,
  et entrée du recap.

**Aperçu**

- **FR-025**: L'onglet « Aperçu » du Focus MUST lister les maquettes et le recap du worktree de l'agent
  et afficher celui qu'on choisit ; HTML et Markdown MUST être rendus, le reste affiché en texte.
- **FR-026**: L'Aperçu MUST NOT faire de requête réseau ni exécuter de script venu d'ailleurs que le
  fichier affiché ; une ressource externe MUST être bloquée et signalée.
- **FR-027**: L'Aperçu MUST se rafraîchir quand le fichier affiché change, en gardant la position de
  lecture.
- **FR-028**: Pour une maquette, l'Aperçu MUST proposer « ✓ Valider » et « ✕ Refuser » avec un
  commentaire facultatif ; la décision MUST être transmise à l'orchestrateur avec la maquette.

**Recap**

- **FR-029**: Le skill recap MUST tenir un fichier recap, versionné dans le worktree de
  l'orchestrateur : par issue, état, agent, rôle, modèle, branche, tours, résultat des tests, PR, et
  une liste « À tester à la main » (ou « rien à tester à la main »).
- **FR-030**: Le recap MUST être affiché dans l'Aperçu du Focus de l'orchestrateur.

**Orchestrateur sous d'autres CLI**

- **FR-031**: L'option « Orchestrateur » MUST être proposée pour tout CLI dont l'adaptateur sait fournir
  à l'agent l'accès MCP de l'orchestrateur et ses skills (extension de 003 FR-001) ; le terminal reste
  le repli pour le reste.

**Plateformes**

- **FR-032**: Rôles, profils, skills, boucle, Aperçu et recap MUST fonctionner à l'identique sur macOS et
  Windows, chemins avec espaces et accents compris.

### Key Entities

- **Rôle** : orchestrateur, spec, design, dev, test ou recap ; porté par un agent.
- **Profil de rôle** : par workspace et par rôle : CLI, modèle, effort, modèle maximal, escalade
  activée ou non.
- **Skill de rôle** : instructions pour un rôle, plus le contrat commun ; même contenu sous forme de
  skill natif ou de fichier d'instructions.
- **Rapport de relais** : issue, agent, rôle, statut, fichiers touchés, commandes de test et codes de
  sortie, questions ouvertes, verdict (test).
- **Issue** : identifiant (local ou distant), titre, critères d'acceptation, état (proposée, prête, en
  cours, faite, escaladée, abandonnée), trace (branche, agents, PR).
- **Boucle** : une issue, son agent dev, son agent test, le numéro du tour (1 à 3), les rapports.
- **Maquette** : fichier HTML du worktree d'un agent design ; décision (en attente, validée, refusée)
  et commentaire.
- **Recap** : fichier du worktree de l'orchestrateur, une entrée par issue.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Dans 100 % des boucles, aucun quatrième tour n'a lieu sans une décision de l'utilisateur.
- **SC-002**: Dans 100 % des cas, une issue marquée « faite » a une exécution de ses tests par PACT à 0,
  postérieure au dernier changement.
- **SC-003**: Un agent lancé avec un rôle démarre avec le modèle de son profil dans 100 % des cas, et
  aucun lancement ne dépasse le modèle maximal du profil.
- **SC-004**: Une décision sur une maquette arrive à l'orchestrateur en moins de 1 seconde après le
  clic ; l'Aperçu se rafraîchit en moins de 2 secondes après un changement de fichier.
- **SC-005**: Dans 100 % des affichages, l'Aperçu ne fait aucune requête réseau.
- **SC-006**: Après une session de travail, l'utilisateur sait en moins de 2 minutes, en lisant le
  recap, ce qui est fait et ce qu'il doit tester, sans ouvrir de terminal.
- **SC-007**: Aucune configuration personnelle de CLI n'est modifiée par PACT (vérifié sur 100 % des
  lancements de la suite de tests).
- **SC-008**: L'ensemble des scénarios d'acceptation passe à l'identique sur macOS et sur Windows.

## Assumptions

- 003 est terminé avant le cœur de 004 : `launch_agent`, `close_agent`, `request_integration` et le
  journal des actions existent ; 004 les étend.
- Les noms de modèles « fort / moyen / petit » sont résolus par CLI dans les profils par défaut (par
  exemple Opus / Sonnet / Haiku pour Claude Code) ; l'utilisateur peut taper n'importe quel nom de
  modèle que son CLI accepte.
- L'escalade de modèle est désactivée par défaut.
- Les issues locales vivent dans le worktree de l'orchestrateur ; la publication distante passe par
  l'outil GitHub en ligne de commande s'il est installé et connecté.
- Les maquettes vivent dans le worktree de l'agent design, le recap dans celui de l'orchestrateur ;
  ils sont intégrés comme tout changement, par la revue de 002.
- Le format des jetons de design suit le format standard des jetons de design (W3C Design Tokens), pour
  être lisible par tout outil.
- « Effort » n'est transmis qu'aux CLI qui le gèrent ; il est ignoré ailleurs.
- Usage mono-utilisateur, en local, comme le socle.
