# Feature Specification: Jauge de limite d'usage

**Feature Branch**: `005-usage-gauge`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Feature 005 « Jauge de limite d'usage » : un visuel dans PACT de la
consommation des limites d'usage de chaque CLI d'agent. Pour Claude Code, ce sont les limites affichées
par /usage (fenêtre de 5 heures, fenêtre hebdomadaire, éventuellement par modèle, avec le pourcentage
utilisé et l'heure de réinitialisation) ; pour Codex, l'équivalent de /status ; pour les autres CLI,
rien si le CLI ne fournit pas l'information (jauge masquée). La jauge est visible dans la barre du
workspace, par CLI, avec un détail au survol ou au clic. Elle montre l'impact : quels agents (et quels
rôles de 004) consomment, alerte avant d'atteindre la limite (par exemple à 80 % et 95 %), et
avertissement avant de lancer une chaîne d'orchestration si la limite risque d'être atteinte. Les
valeurs se mettent à jour pendant que les agents travaillent, sans coût d'usage supplémentaire notable
et sans demander à l'utilisateur de se reconnecter. Lien avec la reprise automatique après limite de
débit (001 FR-036) : l'heure de réinitialisation connue sert aussi à la reprise. macOS et Windows. Hors
périmètre : facturation en euros, limites d'API par clé."

## Références UI

Pas de maquette dédiée. La jauge se place dans la barre d'onglets du workspace (1b), à droite, avant
« À faire ». Apparence : `docs/maquettes/Maquette interactive.dc.html` (R17 de 001) ; couleurs
d'état existantes (attente orange, erreur rouge). Libellés : `docs/maquettes/CONSIGNES-UI.md`.

## Périmètre

**Inclus** : lecture des limites d'usage des CLI qui les fournissent (Claude Code, Codex), une jauge
par CLI utilisé dans le workspace, détail des fenêtres de limite, part de chaque agent ouvert dans la
consommation récente, alertes à des seuils, avertissement au lancement de plusieurs agents ou d'une
chaîne d'orchestration, réutilisation de l'heure de réinitialisation par la reprise automatique.

**Hors périmètre** :

- Coût en euros ou en dollars, facturation.
- Limites d'API par clé (usage d'un CLI avec une clé d'API plutôt qu'un abonnement).
- Historique de consommation au-delà de la fenêtre hebdomadaire.
- Choix automatique d'un autre CLI ou d'un autre modèle quand la limite approche (décision laissée à
  l'utilisateur ou aux profils de 004).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Voir où j'en suis de mes limites (Priority: P1)

L'utilisateur travaille avec trois agents Claude Code et un agent Codex. Dans la barre du workspace, il
voit deux jauges : « Claude Code 62 % · 5 h » et « Codex 18 % · 5 h ». Au survol, le détail s'affiche :
pour chaque fenêtre (5 heures, semaine, et par modèle quand le CLI le donne), le pourcentage utilisé et
l'heure de réinitialisation (« se réinitialise à 16:40 », « lundi 09:00 »). Les jauges bougent pendant
que les agents travaillent.

**Why this priority**: c'est le besoin exprimé : savoir, sans taper `/usage` dans un terminal, combien
de marge il reste.

**Independent Test**: avec un faux CLI qui fournit des limites, vérifier la jauge, son détail et sa
mise à jour quand les valeurs changent ; avec un faux CLI qui n'en fournit pas, vérifier qu'aucune
jauge n'apparaît.

**Acceptance Scenarios**:

1. **Given** un workspace avec des agents d'un CLI qui fournit ses limites, **When** l'utilisateur
   regarde la barre du workspace, **Then** il voit une jauge pour ce CLI, avec le pourcentage de la
   fenêtre la plus proche de sa limite et le nom de cette fenêtre.
2. **Given** une jauge, **When** l'utilisateur la survole ou la clique, **Then** il voit chaque fenêtre
   avec son pourcentage et son heure de réinitialisation, et l'heure de la dernière lecture.
3. **Given** des agents qui travaillent, **When** la consommation change, **Then** la jauge se met à
   jour en moins de 1 minute, sans action de l'utilisateur.
4. **Given** un CLI qui ne fournit pas ses limites, **When** ses agents travaillent, **Then** aucune
   jauge n'apparaît pour lui, et rien ne signale d'erreur.
5. **Given** des valeurs trop anciennes (aucune lecture réussie depuis plus de 15 minutes), **When**
   l'utilisateur regarde la jauge, **Then** elle est grisée avec « lu il y a 20 min ».

---

### User Story 2 - Être prévenu avant d'atteindre la limite (Priority: P1)

La jauge Claude Code passe à 80 % : elle devient orange et un élément « ◆ Limite Claude Code à 80 % ·
5 h · réinitialisation 16:40 » apparaît dans À faire. À 95 %, elle devient rouge. Quand l'utilisateur
veut lancer quatre agents Claude Code alors que la jauge est à 85 %, le lanceur l'avertit : « Limite
5 h à 85 % : ces agents risquent de s'arrêter avant 16:40 ». Il peut lancer quand même.

**Why this priority**: une limite atteinte en pleine chaîne arrête tous les agents d'un coup ;
l'anticiper évite de perdre le travail en cours.

**Independent Test**: faire monter les valeurs d'un faux CLI à 80 puis 95 % ; vérifier les couleurs et
l'élément À faire ; ouvrir le lanceur et vérifier l'avertissement, puis le lancement malgré lui.

**Acceptance Scenarios**:

1. **Given** une fenêtre qui franchit 80 %, **When** la jauge se met à jour, **Then** elle passe en
   orange et À faire affiche une alerte avec le CLI, la fenêtre et l'heure de réinitialisation.
2. **Given** une fenêtre qui franchit 95 %, **When** la jauge se met à jour, **Then** elle passe en
   rouge et l'alerte d'À faire est mise à jour, sans doublon.
3. **Given** une fenêtre au-dessus de 80 %, **When** l'utilisateur lance un ou plusieurs agents de ce
   CLI, ou un orchestrateur, **Then** le lanceur l'avertit avec le pourcentage et l'heure de
   réinitialisation, et le laisse lancer.
4. **Given** une fenêtre réinitialisée, **When** la jauge repasse sous 80 %, **Then** l'alerte disparaît
   d'À faire.
5. **Given** l'utilisateur, **When** il change les seuils dans les réglages, **Then** les alertes
   suivent les nouveaux seuils.

---

### User Story 3 - Savoir qui consomme (Priority: P2)

Dans le détail de la jauge, l'utilisateur voit la part de chaque agent ouvert dans la consommation
depuis l'ouverture du workspace : « Claude Code 1 (orchestrateur) 45 % · Claude Code 2 (test) 35 % ·
Claude Code 3 (dev) 20 % ». Il voit aussi le rôle de chacun (004) quand il en a un, pour régler ses
profils de modèles.

**Why this priority**: utile pour ajuster les profils ou fermer un agent gourmand, mais la jauge seule
répond déjà au besoin principal.

**Independent Test**: faire consommer des quantités connues à trois faux agents ; vérifier les parts
affichées et les rôles.

**Acceptance Scenarios**:

1. **Given** plusieurs agents d'un même CLI, **When** l'utilisateur ouvre le détail de la jauge,
   **Then** il voit la part de chaque agent dans la consommation mesurée par PACT, la plus grande en
   premier, avec son rôle s'il en a un.
2. **Given** un agent fermé, **When** l'utilisateur ouvre le détail, **Then** sa part reste comptée
   jusqu'à la réinitialisation de la fenêtre, marquée « fermé ».
3. **Given** des agents de deux workspaces sur le même CLI, **When** l'utilisateur ouvre le détail dans
   l'un, **Then** il voit le pourcentage du compte (commun) et la part des agents de ce workspace, le
   reste étant « autres ».

---

### User Story 4 - Une reprise automatique à la bonne heure (Priority: P3)

Un agent atteint sa limite. PACT connaît déjà l'heure de réinitialisation par la jauge : la reprise
automatique (001 FR-036) est programmée à cette heure, même quand le message d'erreur du CLI ne la
donne pas.

**Why this priority**: améliore une fonction existante ; la reprise par intervalles croissants reste
le repli.

**Independent Test**: faire échouer un faux agent sur une limite sans heure dans son message, avec une
heure de réinitialisation connue par la jauge ; vérifier que la reprise est programmée à cette heure.

**Acceptance Scenarios**:

1. **Given** une heure de réinitialisation connue pour la fenêtre atteinte, **When** un agent tombe sur
   la limite sans heure dans son message, **Then** la reprise automatique est programmée à cette heure.
2. **Given** aucune heure connue, **When** un agent tombe sur la limite, **Then** la reprise suit les
   intervalles croissants de 001 FR-036.

---

### Edge Cases

- Le CLI change le format de ses limites : la lecture échoue sans planter ; la jauge passe à « lu il y
  a … » puis disparaît après une heure sans lecture ; aucune alerte fausse.
- L'utilisateur n'est pas connecté au CLI, ou utilise une clé d'API : pas de jauge pour ce CLI.
- Plusieurs comptes pour un même CLI selon les agents : une jauge par compte quand le CLI permet de les
  distinguer, sinon une seule.
- Aucun agent ouvert d'un CLI : sa jauge reste visible avec la dernière valeur tant qu'elle date de
  moins d'une heure, puis disparaît.
- Pourcentage au-delà de 100 % ou heure de réinitialisation passée : affichés tels quels, sans planter ;
  l'heure passée est remplacée à la prochaine lecture.
- Fuseau horaire et format d'heure : les heures sont affichées dans le fuseau et le format du système.
- Fenêtre étroite : la jauge se réduit au pourcentage et à une icône, le détail reste accessible.

## Requirements *(mandatory)*

### Functional Requirements

**Lecture des limites**

- **FR-001**: Le système MUST lire, pour chaque CLI qui les fournit, les fenêtres de limite d'usage du
  compte : nom (5 heures, semaine, par modèle le cas échéant), pourcentage utilisé, heure de
  réinitialisation.
- **FR-002**: La lecture MUST NOT consommer de quota d'usage notable, ni ouvrir de session de travail,
  ni demander à l'utilisateur de se reconnecter ; elle MUST utiliser l'identité déjà connue du CLI.
- **FR-003**: Les valeurs MUST être relues au moins une fois par minute tant qu'un agent de ce CLI
  travaille, et au plus une fois toutes les 5 minutes sinon.
- **FR-004**: Un échec de lecture MUST être silencieux pour l'utilisateur (aucune boîte d'erreur) ; la
  dernière valeur reste affichée avec son âge.
- **FR-005**: Le système MUST NOT écrire dans la configuration personnelle des CLI ni conserver de
  secret du CLI en dehors de ce que le CLI stocke déjà.

**Jauge**

- **FR-006**: La barre du workspace MUST afficher une jauge par CLI qui a des agents dans le workspace
  et dont les limites sont connues, avec le pourcentage de la fenêtre la plus proche de sa limite et le
  nom de cette fenêtre.
- **FR-007**: Le détail de la jauge (survol, clic, ou focus clavier) MUST lister chaque fenêtre avec son
  pourcentage, son heure de réinitialisation et l'heure de la dernière lecture.
- **FR-008**: Une jauge dont la dernière lecture date de plus de 15 minutes MUST être grisée avec son
  âge ; au-delà d'une heure, elle MUST disparaître.
- **FR-009**: La jauge MUST exposer son nom, son pourcentage et son état aux technologies d'assistance.

**Alertes**

- **FR-010**: La jauge MUST passer en orange au premier seuil (80 % par défaut) et en rouge au second
  (95 % par défaut) ; les seuils MUST être réglables.
- **FR-011**: Au franchissement d'un seuil, À faire MUST afficher une alerte par CLI (CLI, fenêtre,
  pourcentage, heure de réinitialisation), mise à jour sans doublon et retirée sous le premier seuil.
- **FR-012**: Le lanceur MUST avertir, sans bloquer, quand l'utilisateur lance des agents d'un CLI dont
  une fenêtre dépasse le premier seuil ; l'orchestrateur MUST recevoir le même avertissement quand il
  lance un agent (003 FR-015).

**Impact par agent**

- **FR-013**: Le détail MUST montrer la part de chaque agent du workspace dans la consommation que PACT
  mesure pour ce CLI depuis le début de la fenêtre, avec son rôle (004) s'il en a un, la plus grande en
  premier ; la consommation d'autres sources MUST apparaître comme « autres ».
- **FR-014**: La part d'un agent fermé MUST rester comptée jusqu'à la réinitialisation de la fenêtre.

**Reprise**

- **FR-015**: Quand un agent atteint une limite sans heure dans son message, et qu'une heure de
  réinitialisation est connue pour ce CLI, la reprise automatique MUST être programmée à cette heure
  (extension de 001 FR-036) ; sinon, la règle de 001 FR-036 s'applique.

**Plateformes**

- **FR-016**: Jauge, détail, alertes et lecture MUST fonctionner à l'identique sur macOS et Windows.

### Key Entities

- **Fenêtre de limite** : CLI, compte, nom (5 heures, semaine, par modèle), pourcentage utilisé, heure
  de réinitialisation, heure de lecture.
- **Lecture d'usage** : l'ensemble des fenêtres d'un CLI à un instant, ou un échec.
- **Consommation d'agent** : agent, CLI, quantité mesurée depuis le début de la fenêtre courante.
- **Seuils d'alerte** : premier et second seuil, réglages de l'application.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: L'utilisateur connaît le pourcentage utilisé et l'heure de réinitialisation de chacun de
  ses CLI en un survol, sans ouvrir de terminal.
- **SC-002**: L'écart entre le pourcentage affiché par la jauge et celui affiché par le CLI lui-même au
  même instant ne dépasse pas 2 points, une fois la lecture faite.
- **SC-003**: La jauge reflète un changement de consommation en moins de 1 minute pendant que des
  agents travaillent.
- **SC-004**: La lecture des limites représente moins de 1 % de la consommation d'usage d'une session
  de travail.
- **SC-005**: Dans 100 % des cas, un franchissement de seuil produit une seule alerte par CLI dans
  À faire.
- **SC-006**: L'ensemble des scénarios d'acceptation passe à l'identique sur macOS et sur Windows.

## Assumptions

- Claude Code et Codex exposent leurs limites d'usage d'abonnement sous une forme lisible par PACT
  (sortie structurée, fichier local, ou commande de statut) ; la source exacte de chaque CLI est
  déterminée au plan par une caractérisation sur les vrais CLI, comme la T049 de 001.
- La consommation par agent est mesurée par ce que chaque CLI rapporte de ses tours (jetons ou unités
  équivalentes) ; elle sert à répartir le pourcentage du compte, pas à le recalculer.
- Les seuils par défaut sont 80 % et 95 %.
- Un CLI ajouté par l'utilisateur (« Autre CLI ») n'a pas de jauge.
- Usage mono-utilisateur, en local, comme le socle.
