# Feature Specification: Échanges entre agents et réveil

**Feature Branch**: `007-010-specs`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "007-agent-exchanges : échanges et réveil. Pas de conversation libre entre
agents. Tout passe par PACT : messages courts, typés, copiés à l'orchestrateur, journal visible, plafond
par agent et par tour, escalade si deux agents bouclent. Le code passe par git. Le testeur ne parle au
dev que par verdict structuré. Autorisations et décisions vont à l'utilisateur. Outils proposés :
ask_orchestrator, send_message, get_events. Pas de sommeil ni d'attente bloquante : PACT réveille le
destinataire sur un message `action` (question, rapport, erreur, fin de boucle) ; `info` ne réveille pas.
Inactif : ligne tapée dans son invite. En plein tour : hooks PostToolUse et Stop de Claude Code, à valider
sur le CLI installé sans simuler de touches sur un vrai CLI. Sans hook équivalent : à la fin du tour.
Regroupement de quelques secondes ; PACT tape un pointeur (« 2 événements, lis get_events »), jamais le
texte d'un agent. Jamais par-dessus la saisie de l'utilisateur. Plafond de réveils par heure, coupé quand
la limite de consommation est atteinte. wait_for_agents reste un secours à délai court, plus la méthode
normale ; le skill orchestrateur change en conséquence. Défauts à corriger : start_loop n'envoie aucune
consigne aux agents et ne le dit pas ; launch_agent part du main local même périmé (il doit partir de
origin/main après fetch) ; la référence de départ du testeur est fixée en mémoire au start_loop, donc un
recalage du testeur fait rejeter tout verdict sans issue (la calculer depuis la base réelle) ;
wait_for_agents rend de vieux événements et d'énormes résumés ; les consignes multi-lignes arrivent
emballées en pasted_content."

## Contexte

Aujourd'hui, un agent de rôle ne dispose que de `submit_report` ; seul l'orchestrateur a d'autres outils
(003, 004). L'orchestrateur apprend ce qui se passe en appelant `wait_for_agents`, qui le bloque au plus
240 s puis recommence : il consomme des tours pour rien, et il reste aveugle entre deux attentes. Défauts
constatés dans le code au moment de cette spec :

| Défaut | Où | Constat |
| ------ | -- | ------- |
| Aucune consigne au démarrage d'une boucle | `orchestrator/tools.ts`, `start_loop` | L'outil répond « Boucle démarrée : tour 1/3 » sans rien envoyer aux agents, et sans le dire. |
| Départ depuis un main périmé | `agents/agent-manager.ts`, `launchNow` | La base est `draft.baseBranch ?? workspace.mainBranch`, locale, sans `fetch`. Le service Git n'a pas de `fetch`. |
| Référence de départ du testeur en mémoire | `orchestrator/loop-service.ts`, `testerStart` | Fixée au tree du testeur au `start_loop` et à chaque `next_round`. Après un recalage du testeur, tous les fichiers venus de main comptent comme touchés : tout verdict est rejeté, sans issue. Après un redémarrage de PACT, la carte est vide et le contrôle saute en silence. |
| Vieux événements, résumés énormes | `orchestrator/events.ts`, `loop-service.ts` | La file garde 100 événements jusqu'à la prochaine attente, et une notice de boucle contient la fin de sortie des tests (`outputTail`). |
| Consignes multi-lignes emballées | `agents/agent-manager.ts`, `flushPrompt` | Un texte multi-ligne part en collage (bracketed paste) ; Claude Code le remet à l'agent emballé en `<pasted_content>`, qu'il traite comme une matière collée et non comme une consigne. |
| Saisie de l'utilisateur écrasée | `agents/agent-manager.ts`, `flushPrompt`, `typed` | PACT tape dans l'invite dès que l'agent est prêt, sans regarder si l'utilisateur a commencé à écrire. |

## Références UI

Pas de maquette dédiée. Le journal des échanges rejoint le journal « ◎ Actions » de l'orchestrateur (003
US5). L'escalade est un élément de la zone d'action de l'utilisateur : « À faire », tête de la colonne
« Agents » une fois 006 livrée. Libellés : `docs/maquettes/CONSIGNES-UI.md`.

## Dépendances

- **Prérequis** : 003, 004 (rôles, boucles), 005 (lecture de la consommation).
- **Conseillé d'abord** : 006 (`origin/006-agents-view`, pas encore sur `main`) touche les mêmes colonnes
  et le même modèle de workspace.
- **Requise par** : 009 (consigne de sauvegarde en plein tour), 008 (réveil à chaque résultat de
  livraison), 010 (événements du moteur de workflow).

## Périmètre

**Inclus** : les trois outils d'échange ; les messages typés `action` et `info` ; leur journal ; les
plafonds ; l'escalade d'une boucle entre deux agents ; le réveil des agents ; la place de
`wait_for_agents` et la réécriture du skill orchestrateur ; la correction des cinq défauts du contexte.

**Hors périmètre** :

- Une conversation libre entre agents, un canal de partage de code ou de fichiers.
- Tout outil d'échange qui rapporte du contenu écrit par un tiers sur la forge.
- La réponse d'un agent à une autorisation ou à une décision de l'utilisateur.
- Le modèle d'exécution par graphe (010) et le remplacement de `request_integration` (008).
- Le réveil d'un CLI générique en plein tour : il n'a pas de hook, il attend la fin de tour.

## Clarifications

### Session 2026-11-05

Décisions données par l'utilisateur avec la demande, à ne pas rouvrir :

- Q: Les agents peuvent-ils converser librement ? → A: non. Tout passe par PACT : messages courts, typés,
  copiés à l'orchestrateur, journal visible, plafond par agent et par tour, escalade si deux agents
  bouclent.
- Q: Comment le code et les verdicts circulent-ils ? → A: le code par git ; le testeur ne parle au dev
  que par verdict structuré ; autorisations et décisions vont à l'utilisateur.
- Q: Comment un agent attend-il ? → A: il n'attend pas. PACT le réveille sur un message `action`
  (question, rapport, erreur, fin de boucle) ; un message `info` ne réveille pas.
- Q: Comment le réveil arrive-t-il ? → A: agent inactif, une ligne tapée dans son invite ; en plein tour,
  les hooks PostToolUse et Stop de Claude Code, à valider sur le CLI installé sans simuler de touches ;
  sans hook équivalent, à la fin du tour.
- Q: Que tape PACT ? → A: un pointeur (« 2 événements, lis get_events »), jamais le texte d'un agent,
  jamais par-dessus la saisie de l'utilisateur, après un regroupement de quelques secondes.
- Q: Le réveil a-t-il une limite ? → A: un plafond par heure, et il est coupé quand la limite de
  consommation est atteinte.
- Q: Que devient `wait_for_agents` ? → A: un secours à délai court, plus la méthode normale ; le skill
  orchestrateur change en conséquence.
- Q: D'où part `launch_agent` ? → A: de `origin/main` après `fetch`.
- Q: Comment calculer la référence de départ du testeur ? → A: depuis la base réelle, plus en mémoire.
- Q: Le dépôt peut être public : qu'est-ce qu'un agent peut lire ? → A: le contenu écrit par un tiers (PR, issue, commentaire,
  description, nom de branche, journal de CI d'un fork) est non fiable et ne doit jamais atteindre un agent, ni être lu,
  récupéré, exécuté ou fusionné par PACT.

Décisions de l'utilisateur sur les propositions, le 2026-11-05 :

- Q1: Quelles valeurs ? → A: 500 caractères par message ; 5 messages par agent et par tour ; regroupement de 5 s ; 20 réveils par
  heure et par agent ; boucle à 3 allers-retours entre les deux mêmes agents sans nouveau commit ; `wait_for_agents` à 60 s au plus ;
  20 événements de 200 caractères rendus.
- Q2: Une consigne de l'orchestrateur passe-t-elle par le pointeur ? → A: oui. Elle devient un message `action` lu par `get_events`,
  avec une seule ligne dans l'invite.
- Q3: Un CLI sans MCP ? → A: PACT écrit ses événements dans un fichier de son worktree exclu de git, et le pointeur nomme ce fichier.
- Q4: Le type des autres événements ? → A: `action` pour `report-missing`, résultat d'une demande de livraison ou d'intégration,
  `publish`, `mockup` ; `info` pour `turn-finished`, `closed`, `awaiting-answer`, `overlap`.
- Q5: Qui écrit à qui ? → A: le dev et le testeur ne s'écrivent dans aucun sens, ni message ni `send_message` : seuls le verdict
  structuré et git passent entre eux. L'orchestrateur écrit à tous, `ask_orchestrator` pour tout agent, `send_message` entre les autres
  agents de rôle avec copie à l'orchestrateur ; sans orchestrateur, envoi refusé avec sa raison. (Voir Q13.)
- Q6: Après l'escalade d'une boucle ? → A: les messages entre ces deux agents sont refusés jusqu'à la décision de l'utilisateur
  (« Laisser reprendre » ou « Couper ») ; les autres échanges continuent.
- Q7: Quelle limite coupe les réveils ? → A: le niveau `critical` de 005 tant que 009 n'est pas là, puis le seuil d'arrêt de 009. Les
  événements restent lisibles ; le pointeur part à la reprise.
- Q8: Sans réseau, et le lanceur de l'utilisateur ? → A: `fetch` en échec : départ du dernier `origin/main` connu, avec l'avertissement
  dans la réponse ; sans remote : main local ; `baseBranch` explicite respectée ; le lanceur de l'utilisateur suit la même règle.
- Q9: Le journal survit-il ? → A: gardé dans le workspace, 500 messages par workspace ; les événements non lus repartent par un
  pointeur à la reprise.
- Q10: Une saisie abandonnée ? → A: PACT ne tape jamais tant que l'invite n'est pas vide, et signale après 2 minutes qu'un réveil attend
  sa saisie ; les hooks n'écrivent pas dans l'invite.
- Q11: `start_loop` ? → A: PACT envoie au testeur la consigne d'écrire les tests de l'issue, puis au dev la sienne au premier rapport du
  testeur ; la réponse de l'outil dit ce qui est parti et à qui.
- Q12: Le shell d'un agent ? → A: les skills interdisent de lire le contenu d'un tiers, et les règles d'autorisation de PACT font passer ces
  commandes par la décision de l'utilisateur, sur les CLI qui ont ces règles. Sur les autres, la garantie reste partielle, et c'est dit à
  l'utilisateur.

## Questions ouvertes

Une seule question, née de la décision Q5 : l'agent spec ne la tranche pas.

- **Q13 — Le dev et le testeur peuvent-ils utiliser `send_message` vers un autre rôle ?** « Entre les autres agents de rôle » se lit de deux
  façons : (a) toutes les paires sauf dev ↔ testeur, donc un testeur peut écrire au design, et deux devs entre eux ; (b) seuls les rôles autres
  que dev et testeur ont l'outil. *Proposition* : (a), car la règle vise la paire dev ↔ testeur ; à noter qu'un tiers pourrait alors servir de
  relais entre eux, ce qui reste visible par la copie à l'orchestrateur.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - L'orchestrateur travaille sans attendre (Priority: P1)

L'orchestrateur lance un dev et un testeur, puis finit son tour au lieu de se bloquer. Quand le testeur
rend son rapport, PACT tape dans son invite « 1 événement, lis get_events ». Il lit le rapport, passe au
tour suivant, et se rendort sans outil d'attente. L'utilisateur ne voit plus d'attentes vides dans le
terminal de l'orchestrateur, et la consommation baisse.

**Why this priority**: c'est le cœur de la demande, et 008, 009 et 010 reposent sur ce réveil.

**Independent Test**: avec un faux CLI en orchestrateur et un faux agent, faire rendre un rapport à
l'agent ; vérifier le pointeur tapé une seule fois dans l'invite, le contenu rendu par `get_events`, et
qu'aucun appel à `wait_for_agents` n'est nécessaire.

**Acceptance Scenarios**:

1. **Given** un orchestrateur inactif, **When** un agent rend un rapport, **Then** PACT tape dans son
   invite un pointeur d'une ligne (« 1 événement, lis get_events ») et ne tape aucun texte de l'agent.
2. **Given** un orchestrateur inactif, **When** trois événements `action` arrivent dans le délai de
   regroupement, **Then** il ne reçoit qu'un seul pointeur, qui annonce 3 événements.
3. **Given** un orchestrateur inactif, **When** un événement `info` arrive, **Then** rien n'est tapé, et
   l'événement figure à sa prochaine lecture de `get_events`.
4. **Given** un agent qui vient de lire ses événements, **When** il rappelle `get_events`, **Then** aucun
   événement déjà lu ne lui est rendu comme nouveau.
5. **Given** l'utilisateur qui écrit dans l'invite d'un agent inactif, **When** un événement `action`
   arrive, **Then** PACT n'écrit rien ; le pointeur part une fois l'invite vide ou la saisie envoyée.
6. **Given** une saisie laissée dans l'invite, **When** 2 minutes passent, **Then** l'utilisateur est prévenu qu'un réveil attend, et PACT n'écrit toujours rien.
7. **Given** une consigne multi-ligne de l'orchestrateur, **When** elle part, **Then** l'agent reçoit une seule ligne dans son invite, et lit la consigne par `get_events`, sans
   emballage.

---

### User Story 2 - Un agent en plein tour reçoit l'événement (Priority: P1)

L'orchestrateur est en plein tour quand un testeur signale une erreur. PACT lui transmet le pointeur par
le hook de fin d'outil de Claude Code, sans toucher à son terminal. Un agent d'un CLI sans hook équivalent
reçoit le pointeur à la fin de son tour.

**Why this priority**: sans cela, une question urgente attend la fin d'un long tour, et la consigne de
sauvegarde de 009 ne peut pas arriver.

**Independent Test**: la validation du hook sur le CLI installé (FR-012) passe ; un faux CLI à hooks reçoit
le pointeur dans la réponse de son hook de fin d'outil ; un faux CLI sans hook le reçoit dans son invite à
sa fin de tour.

**Acceptance Scenarios**:

1. **Given** un agent Claude Code en plein tour, **When** un événement `action` arrive, **Then** le pointeur
   lui parvient à la fin de son prochain outil, sans aucune écriture dans son terminal.
2. **Given** un agent Claude Code qui va finir son tour avec un événement `action` non lu, **When** son tour
   s'achève, **Then** il reçoit le pointeur ; PACT ne compte ni fin de tour, ni rapport manquant, puisque le
   tour continue.
3. **Given** un agent d'un CLI sans hook équivalent, en plein tour, **When** un événement `action` arrive,
   **Then** le pointeur lui est tapé à sa fin de tour.
4. **Given** un sous-agent ou un coéquipier interne d'un agent, **When** il termine un outil, **Then** PACT
   ne lui remet pas le pointeur : il attend l'agent lui-même.

---

### User Story 3 - Des échanges courts, typés et visibles (Priority: P1)

Un dev a une question sur l'issue : il appelle `ask_orchestrator`, finit son tour, et sera réveillé à la
réponse. L'utilisateur voit l'échange dans le journal. Un testeur qui essaie d'écrire au dev est refusé :
il doit passer par son verdict. Deux agents qui se renvoient la balle sont arrêtés, et l'utilisateur tranche.

**Why this priority**: c'est la règle de sécurité et de coût demandée, sans laquelle le réveil devient une
conversation libre.

**Independent Test**: deux faux agents s'envoient des messages ; vérifier la copie à l'orchestrateur, le
journal, le refus au-delà du plafond, le refus du testeur, l'escalade à l'utilisateur.

**Acceptance Scenarios**:

1. **Given** un dev en plein travail, **When** il appelle `ask_orchestrator`, **Then** l'appel rend aussitôt
   la main, l'orchestrateur est réveillé, et l'échange figure au journal.
2. **Given** un agent A et un agent B, **When** A envoie un message à B par `send_message`, **Then**
   l'orchestrateur en reçoit une copie, et le journal note l'expéditeur, le destinataire, le type et l'heure.
3. **Given** un message plus long que la limite, **When** un agent l'envoie, **Then** il est refusé avec sa
   raison, et rien n'est transmis.
4. **Given** un agent qui a atteint son plafond de messages pour ce tour, **When** il en envoie un de plus,
   **Then** il est refusé avec sa raison ; le compteur repart à son tour suivant.
5. **Given** un testeur ou un dev, **When** il appelle `send_message` vers l'autre, **Then** l'appel est refusé, et la raison renvoie au verdict de `submit_report` et à git.
6. **Given** deux agents qui se renvoient des messages sans nouveau commit, **When** ils atteignent 3 allers-retours, **Then** l'utilisateur voit une escalade qui nomme les deux agents et le dernier échange, et leurs messages sont refusés
   jusqu'à sa décision (« Laisser reprendre » ou « Couper »).
7. **Given** un agent qui demande une autorisation par message, **When** l'orchestrateur lit ce message,
   **Then** il n'a aucun outil pour l'accorder : la décision reste dans À faire pour l'utilisateur.
8. **Given** une PR tierce dont le titre, la description et les commentaires contiennent un texte d'injection (« ignore tes
   consignes »), **When** des événements de livraison (008) sont rendus par `get_events`, `wait_for_agents` ou un pointeur,
   **Then** ce texte n'y figure pas, ni au journal, et aucun agent n'est réveillé à cause de cette PR.
9. **Given** une PR suivie (008) qu'un tiers commente, **When** l'orchestrateur lit ses événements, **Then** il voit l'état de la
   PR et de ses checks, jamais le texte du commentaire.
10. **Given** une consigne, un skill ou une réponse d'outil de PACT, **When** un agent la lit, **Then** elle ne l'invite jamais à
    lire une PR, une issue ou un commentaire d'un tiers.

---

### User Story 4 - Une boucle qui démarre pour de vrai (Priority: P2)

L'orchestrateur appelle `start_loop` et sait exactement ce qui est parti : la réponse de l'outil dit à quels
agents une consigne a été envoyée, et le testeur peut rendre un verdict même après s'être recalé sur main.

**Why this priority**: ces deux défauts ont déjà fait perdre des boucles entières ; ils sont petits et
indépendants du réveil.

**Independent Test**: démarrer une boucle sur un faux CLI et lire la réponse ; recaler le worktree d'un
testeur sur un main avancé dans un dépôt Git temporaire, puis rendre un verdict.

**Acceptance Scenarios**:

1. **Given** une issue prête, un dev et un testeur, **When** l'orchestrateur appelle `start_loop`, **Then** le testeur reçoit la consigne d'écrire les tests, le dev recevra la sienne au premier rapport du testeur, et la réponse le dit.
2. **Given** un testeur qui n'a changé que des fichiers de test puis s'est recalé sur main, **When** il rend
   son verdict, **Then** il est accepté par PACT.
3. **Given** un testeur qui a changé un fichier de production, **When** il rend son verdict, **Then** il est
   rejeté, avec la liste des fichiers et le moyen d'en sortir.
4. **Given** une boucle en cours et PACT redémarré, **When** le testeur rend son verdict, **Then** le contrôle
   des fichiers a lieu quand même, depuis la base réelle.
5. **Given** un main local en retard sur `origin/main`, **When** l'orchestrateur appelle `launch_agent` sans
   branche de départ, **Then** la branche de l'agent part du `origin/main` à jour.
6. **Given** un `fetch` en échec, **When** l'orchestrateur appelle `launch_agent`, **Then** la branche part du dernier `origin/main` connu, et la réponse l'avertit.
7. **Given** un dépôt sans remote, ou une `baseBranch` explicite, **When** un agent est lancé, **Then** il part du main local, ou de cette branche.

---

### User Story 5 - `wait_for_agents` reste un secours propre (Priority: P3)

Un orchestrateur sur un CLI où le réveil échoue utilise encore `wait_for_agents` : il rend vite la main, avec
des événements récents et courts.

**Why this priority**: c'est le filet de sécurité, plus le chemin normal.

**Independent Test**: accumuler des événements dont une sortie de tests très longue ; vérifier ce que rend
l'outil, puis le skill livré.

**Acceptance Scenarios**:

1. **Given** des événements non lus dont un résumé très long, **When** l'orchestrateur appelle
   `wait_for_agents`, **Then** chaque résumé est tronqué à la limite, et le détail se lit par `get_events` ou
   `get_loop`.
2. **Given** plus d'événements que la limite, **When** l'outil répond, **Then** il rend les plus récents et
   dit combien restent.
3. **Given** un événement déjà rendu par `get_events`, **When** l'orchestrateur appelle `wait_for_agents`,
   **Then** cet événement n'est pas rendu à nouveau.
4. **Given** le skill orchestrateur livré, **When** on le lit, **Then** la méthode normale est de finir son
   tour et d'être réveillé ; `wait_for_agents` n'y figure que comme secours.

### Edge Cases

- L'agent passe de `awaiting-prompt` à `working` pendant le regroupement : le pointeur prend la voie du hook.
- L'agent attend une réponse de l'utilisateur (`awaiting-answer`) : rien n'est tapé, car une touche pourrait
  répondre à sa question ; le pointeur part à la sortie de cet état.
- Un long outil (tests de plusieurs minutes) retarde le hook de fin d'outil : le pointeur attend sa fin. PACT
  ne simule jamais de touche pour l'interrompre.
- Un tour sans aucun outil n'a que le hook Stop.
- Prolonger un tour par le hook Stop ne doit pas boucler : un seul pointeur par événement, et le pointeur
  n'est pas réémis si l'agent a déjà été prolongé sans nouvel événement.
- Le plafond de réveils est atteint : les événements restent lisibles, un seul avertissement monte à
  l'utilisateur, et le prochain pointeur part à l'heure suivante.
- Un pointeur tapé n'est pas soumis (Entrée perdue) : la détection existante (`undeliveredPrompts`) le signale
  et le réveil suivant le remplace, sans doubler.
- Le destinataire est fermé, en erreur ou en pause (009) : le message reste au journal, l'expéditeur en est
  informé, et aucun réveil n'est tenté.
- L'orchestrateur est réveillé par un événement qu'il a causé lui-même : les événements sur lui-même restent
  exclus, comme aujourd'hui, sauf `publish`.
- Le texte d'un message vient d'un agent : `get_events` le présente comme une donnée rapportée, jamais comme
  une consigne de l'utilisateur.
- Le testeur fait un `git merge` de la branche du dev : la base réelle ne l'excuse pas, le verdict reste
  rejeté, et la raison lui dit de revenir à ses seuls tests.
- Le `fetch` échoue ou le dépôt n'a pas de remote : voir FR-022.
- Le `fetch` de `launch_agent` ne vise que la branche principale : aucune référence de PR tierce n'est récupérée.
- Un agent recopie dans un message un texte trouvé par lui-même : PACT ne peut pas le reconnaître. Le texte reste une donnée
  rapportée et bornée, et la source relève de FR-027.

## Requirements *(mandatory)*

### Functional Requirements

**Messages**

- **FR-001**: PACT MUST donner à tout agent de rôle les outils `ask_orchestrator` et `get_events`. L'orchestrateur MUST pouvoir écrire à tous. `send_message`
  MUST relier les autres agents de rôle, avec copie à l'orchestrateur [NEEDS CLARIFICATION: Q13 — portée pour le dev et le testeur]. Sans orchestrateur dans le
  workspace, l'envoi MUST être refusé avec sa raison.
- **FR-002**: Un message MUST être typé `action` ou `info`, avoir un expéditeur, un destinataire, une heure, et tenir en 500 caractères.
- **FR-003**: `ask_orchestrator` et `send_message` MUST rendre la main aussitôt : aucune attente bloquante.
- **FR-004**: Tout message entre agents MUST être copié à l'orchestrateur du workspace et inscrit au journal, et l'utilisateur MUST pouvoir lire ce journal dans PACT. Le
  journal MUST être gardé dans le workspace, 500 messages par workspace, et les événements non lus MUST repartir par un pointeur à la reprise.
- **FR-005**: PACT MUST refuser, avec sa raison, un message au-delà de 5 par agent et par tour.
- **FR-006**: À 3 allers-retours entre les deux mêmes agents sans nouveau commit, PACT MUST escalader à l'utilisateur, et refuser les messages entre ces deux agents jusqu'à sa
  décision (« Laisser reprendre » ou « Couper ») ; les autres échanges continuent.
- **FR-007**: Le dev et le testeur MUST ne s'écrire dans aucun sens : `send_message` entre eux est refusé, seuls le verdict structuré et git passent. Un verdict `defects` accepté par
  PACT MUST parvenir au dev comme un message `action`.
- **FR-008**: Aucun outil d'échange ne MUST permettre d'accorder une autorisation ou de prendre une décision de
  l'utilisateur : ces demandes restent dans sa zone d'action.
- **FR-009**: `get_events` MUST rendre les événements non lus de l'agent, une seule fois, 20 au plus, avec un résumé de 200 caractères au plus, et permettre de relire le détail du
  journal.

**Réveil**

- **FR-010**: PACT MUST réveiller le destinataire d'un message `action` : question, rapport, erreur, fin de boucle, `report-missing`, résultat d'une demande de livraison ou d'intégration,
  `publish`, `mockup`. Il MUST ne pas le réveiller pour un message `info` : `turn-finished`, `closed`, `awaiting-answer`, `overlap`.
- **FR-011**: PACT MUST regrouper les événements d'un destinataire pendant 5 s, et transmettre un seul pointeur qui en donne le nombre et nomme `get_events`. Pour un CLI sans MCP, PACT MUST
  écrire les événements dans un fichier de son worktree exclu de git, et le pointeur MUST nommer ce fichier.
- **FR-012**: Avant d'en dépendre, l'équipe MUST valider sur le CLI Claude Code installé (2.1.318 à la date de cette
  spec ; l'adapter est caractérisé sur 2.1.281) que les hooks PostToolUse et Stop remettent un texte à l'agent, par
  une session pilotée sans aucune touche simulée, et consigner le résultat dans la recherche du plan. Si la
  validation échoue, le réveil en plein tour retombe sur la fin de tour.
- **FR-013**: Pour un agent inactif, le pointeur MUST être une seule ligne tapée dans son invite ; pour un agent en
  plein tour avec hook, il MUST passer par le hook ; sans hook équivalent, il MUST être tapé à la fin du tour.
- **FR-014**: PACT MUST ne jamais écrire dans l'invite d'un agent tant qu'elle n'est pas vide, ni pendant que l'agent attend une réponse. Après 2 minutes, il MUST signaler à l'utilisateur
  qu'un réveil attend sa saisie.
- **FR-015**: PACT MUST ne jamais taper le texte d'un agent. Une consigne de l'orchestrateur MUST devenir un message `action` lu par `get_events`, avec une seule ligne dans l'invite.
- **FR-016**: PACT MUST appliquer un plafond de 20 réveils par heure et par agent, et cesser les réveils à la limite de consommation : niveau `critical` de 005 tant que 009 n'est pas
  livrée, puis seuil d'arrêt de 009. Aucun événement n'est perdu, et le pointeur part à la reprise.
- **FR-017**: Une consigne de sauvegarde de 009 MUST rester transmissible malgré le plafond de réveils : un arrêt à
  la limite ne doit pas dépendre d'un plafond atteint.
- **FR-018**: Un tour prolongé par un réveil MUST ne pas être compté comme une fin de tour, ni déclencher
  `report-missing`.

**Attente et skill**

- **FR-019**: `wait_for_agents` MUST attendre 60 s au plus, rendre les événements non lus depuis la dernière lecture, partager cette lecture avec `get_events`, et rendre 20 événements de 200
  caractères au plus.
- **FR-020**: Le skill `pact-orchestrator`, le contrat commun et les skills de rôle MUST décrire les échanges et le
  réveil comme méthode normale, et `wait_for_agents` comme secours.

**Défauts**

- **FR-021**: À `start_loop`, PACT MUST envoyer au testeur la consigne d'écrire les tests de l'issue, puis au dev la sienne au premier rapport du testeur, et la réponse de l'outil MUST dire ce qui
  est parti et à qui.
- **FR-022**: `launch_agent` sans branche de départ MUST faire un `fetch` et partir de `origin/<branche principale>`. `fetch` en échec : départ du dernier `origin/main` connu, avec
  l'avertissement dans la réponse. Sans remote : main local. Une `baseBranch` explicite MUST être respectée. Le lanceur de l'utilisateur MUST suivre la même règle.
- **FR-023**: Le contrôle des fichiers du testeur MUST partir de la base réelle de sa branche avec la branche
  principale, calculée à chaque verdict : un recalage ne le fait plus échouer, et un redémarrage ne le saute plus.
- **FR-024**: Une consigne multi-ligne MUST parvenir à l'agent comme une consigne, sans emballage `<pasted_content>`, par la voie de FR-015.
- **FR-025**: La fin de sortie des tests et les listes de fichiers MUST ne plus figurer dans le résumé d'un
  événement : elles se lisent à la demande.

**Contenu de tiers**

- **FR-026**: Aucun message, événement, pointeur, consigne ni entrée de journal créé par PACT MUST ne contenir de contenu écrit par un tiers
  (PR, issue, commentaire, description, nom de branche, journal de CI d'un fork). Un événement sur une PR suivie (008) MUST se limiter à
  ses données de structure.
- **FR-027**: Les skills et les consignes de PACT MUST interdire à un agent de lire ou de récupérer ce contenu, et les règles d'autorisation de PACT MUST faire passer ces commandes par la décision de
  l'utilisateur, sur les CLI qui ont ces règles. Sur les autres, la garantie reste partielle, et PACT MUST le dire à l'utilisateur.

### Key Entities

- **Message** : expéditeur, destinataire, type (`action`, `info`), sous-type (question, rapport, erreur, fin de
  boucle…), texte court, heure, état de lecture.
- **Journal des échanges** : les messages d'un workspace, lisibles par l'utilisateur et par l'orchestrateur.
- **Curseur de lecture** : ce qu'un agent a déjà lu ; partagé entre `get_events` et `wait_for_agents`.
- **Réveil** : un pointeur pour un destinataire, sa voie (invite, hook de fin d'outil, hook de fin de tour, fin de
  tour), son compteur horaire.
- **Escalade d'échange** : deux agents, le dernier échange, la décision de l'utilisateur.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sur une boucle dev ↔ test complète, l'orchestrateur n'appelle aucune attente, et ses tours inactifs sont
  remplacés par des réveils.
- **SC-002**: Un événement `action` atteint un agent inactif en moins de 10 s, délai de regroupement compris.
- **SC-003**: Dans aucun scénario de test, PACT n'écrit dans une invite où l'utilisateur a une saisie en cours.
- **SC-004**: Aucun texte d'agent n'apparaît dans l'invite d'un autre agent au titre d'un réveil.
- **SC-005**: 100 % des messages entre agents figurent au journal et en copie à l'orchestrateur.
- **SC-006**: Un testeur recalé sur main obtient l'acceptation de son verdict du premier coup.
- **SC-007**: Un agent lancé sans branche de départ part toujours du `origin/main` obtenu par un `fetch` réussi.
- **SC-008**: Ce que rend `wait_for_agents` tient sous la borne fixée, quelle que soit la longueur des sorties de test.
- **SC-009**: Sur 100 % des scénarios de test, une chaîne témoin d'injection placée dans une PR tierce n'apparaît dans aucun message, événement,
  pointeur ni entrée de journal.

## Assumptions

- « Projet » et « workspace » désignent la même chose (voir 006).
- Les tests automatisés utilisent le faux CLI ; aucun test ne pilote un vrai CLI avec des touches simulées.
- Les 10 s de SC-002 sont une proposition de l'agent spec, cohérente avec le regroupement de 5 s décidé.
- Le service Git gagnera `fetch` ; `gh` reste réservé à 004 et 008.
- Le contrat MCP des outils existants ne change que là où cette spec le dit.
