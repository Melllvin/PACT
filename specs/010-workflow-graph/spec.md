# Feature Specification: Workflow configurable en graphe

**Feature Branch**: `007-010-specs`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "010-workflow-graph : workflow configurable. Éditeur de graphe visuel dans PACT, avec une forme texte ou
code équivalente, un peu comme LangGraph ; versionnable dans le dépôt. L'étape et ses agents (rôle, modèle), les transitions, le nombre
maximum de tours. Première phase : séquence et boucles, par exemple spec → dev ↔ test → peaufinage → PR. Seconde phase, à décrire sans la
détailler : parallèle et conditions. Le modèle de données doit la permettre dès le début. S'articule avec 007 (événements) et 008
(livraison). Donne les dépendances entre les quatre specs et un ordre conseillé."

## Contexte

La chaîne de 004 est écrite en dur : l'ordre est dans le skill `pact-orchestrator`, le plafond de tours dans le code, et l'orchestrateur la
suit de lui-même, sans que PACT sache où on en est. L'utilisateur veut composer ses étapes, les voir, et les versionner avec le projet.

## Références UI

Pas de maquette dédiée : à produire au plan. La vue « Graphe » de 006 montre, en lecture, les agents en cours et leurs liens. L'éditeur de
cette spec décrit, lui, le déroulé prévu : les deux ne doivent pas porter le même nom. Cette spec l'appelle « Workflow ». Libellés :
`docs/maquettes/CONSIGNES-UI.md`.

## Dépendances entre les quatre specs et ordre conseillé

```text
005 (lectures) ──► 009
003, 004 ────────► 007 ──► 009
                    │
                    ├────► 008 ──► 010
                    └─────────────► 010
```

| Spec | A besoin de | Pourquoi |
| ---- | ----------- | -------- |
| 007 échanges et réveil | 003, 004 ; 005 pour la coupure à la limite | Socle de tout le reste : messages, événements, réveil. |
| 009 arrêt à une limite | 005, 001, 007 | Sa consigne de sauvegarde en plein tour et son réveil à la reprise sont ceux de 007. |
| 008 livraison | 004, 007 | Son réveil à chaque résultat est celui de 007 ; 009 n'est pas nécessaire. |
| 010 workflow | 007, 008 | Ses étapes réagissent aux événements de 007 ; son étape « PR » et ses réglages de tours et de peaufinage sont ceux de 008. |

**Ordre conseillé** : terminer 006 (son modèle de workspace et sa colonne « Agents » touchent les mêmes écrans), puis **007 → 009 → 008 → 010**.

- 007 d'abord : tout en dépend.
- 009 avant 008 : elle est plus petite, et protège le travail dès que le réveil permet aux agents de tourner seuls, avant que les livraisons
  automatiques ne multiplient les tours.
- 008 avant 010 : un workflow doit pouvoir nommer une vraie étape de livraison.
- Les quatre modifient `workspaceSchema`, `tools.ts` et le skill orchestrateur : à livrer l'une après l'autre, pas en parallèle.
- 011 vient après 008, dont elle reprend les critères d'un élément sûr.

## Périmètre

**Inclus (première phase)** : un éditeur visuel dans PACT ; une forme texte équivalente, versionnée dans le dépôt ; les étapes, leurs agents
(rôle, modèle), les transitions, les séquences et les boucles avec leur nombre maximum de tours ; la validation d'un workflow ; le suivi de
l'étape en cours ; un workflow par défaut équivalent à la chaîne de 004 et 008.

**Seconde phase, décrite sans être détaillée** : étapes parallèles et conditions. Le modèle de données les permet dès le début (FR-006) ; ni
l'éditeur ni le moteur ne les exécutent en première phase.

**Hors périmètre** :

- L'exécution de code arbitraire venu du dépôt comme étape.
- Une bibliothèque de workflows partagés entre projets.
- Plus de 6 agents par workspace.
- La vue d'état en direct des agents (006).

## Clarifications

### Session 2026-11-05

Décisions données par l'utilisateur avec la demande, à ne pas rouvrir :

- Q: Quelle forme ? → A: un éditeur de graphe visuel dans PACT, avec une forme texte ou code équivalente, un peu comme LangGraph, versionnable
  dans le dépôt.
- Q: Que décrit-on ? → A: l'étape et ses agents (rôle, modèle), les transitions, le nombre maximum de tours.
- Q: Quel découpage ? → A: première phase, séquence et boucles (par exemple spec → dev ↔ test → peaufinage → PR) ; seconde phase, à décrire sans
  la détailler, parallèle et conditions. Le modèle de données doit la permettre dès le début.
- Q: Quelles articulations ? → A: 007 pour les événements, 008 pour la livraison.

Décisions de l'utilisateur sur les propositions, le 2026-11-05 :

- Q1: Texte déclaratif ou code ? → A: un fichier déclaratif, sans code exécutable, à un chemin fixe : `.pact/workflow.yaml`.
- Q2: Qui fait avancer le workflow ? → A: PACT garde l'état, ne permet que les transitions du graphe et refuse les autres avec leur raison ; l'orchestrateur lance les agents et donne les consignes. (Précisé par Q10.)
- Q3: Combien de workflows ? → A: un par projet en première phase ; le format nomme son workflow, pour en permettre plusieurs plus tard.
- Q4: Quelle version fait foi ? → A: le fichier de la branche principale à jour ; un agent ne peut pas le changer pour lui-même ; une exécution en cours garde la version de son démarrage ; un changement
  s'applique à la suivante.
- Q5: Avec les réglages de 008 ? → A: le fichier est la seule source pour le plafond et les passes, et les paramètres du projet l'éditent ; le mode de fusion est un réglage de projet versionné dans ce
  fichier ; le toggle Auto reste local. (Précisé par Q9.)
- Q6: Modèle d'une étape ? → A: le plafond du profil de rôle s'applique toujours ; un modèle absent ou trop élevé rend le workflow invalide sur cette machine, avec sa raison, sans remplacement silencieux.
- Q7: Quelles étapes ? → A: les rôles existants (spec, design, dev, test, recap), plus peaufinage et PR, avec une consigne libre par étape ; pas d'étape sur mesure.
- Q8: La mise en page ? → A: les positions sont optionnelles dans le fichier, sans influence sur le comportement ; l'éditeur les écrit seulement si l'utilisateur déplace un nœud ; la disposition automatique
  sert sinon.
- Q9: Où va un enregistrement ? → A: l'enregistrement de l'éditeur ou des paramètres crée une branche et une PR, toujours relue par l'utilisateur ; la version courante s'applique jusqu'à sa fusion ; pour un projet sans fichier, le premier enregistrement est le seul geste qui en crée un.
  La reprise des réglages de 008, livrée avant, est écrite ici de façon cohérente avec cette décision (FR-020).
- Q10: Qui envoie les consignes de départ ? → A: PACT envoie la consigne de l'étape écrite dans le workflow, comme 007 ; l'orchestrateur ajoute le reste.

## Questions ouvertes

Une question, née de Q9 : l'agent spec ne la tranche pas.

- **Q11 — Où va un enregistrement quand aucune PR n'est possible ?** Q9 passe par une PR. Or un dépôt sans remote n'a pas de PR, et 008 ne donne aucune voie de livraison à un remote non GitHub ou sans `gh`. Dans ces cas, l'éditeur et les paramètres ne pourraient plus rien enregistrer.
  *Proposition* : sans remote, l'enregistrement passe par le geste « Fusionner sans verdict » de 008 ; remote non GitHub ou `gh` absent, il est refusé avec sa raison, et l'utilisateur modifie le fichier lui-même avec Git ; les réglages restent lisibles.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Lancer le workflow par défaut (Priority: P1)

Sans rien configurer, l'utilisateur retrouve la chaîne habituelle, et voit où en est une issue. Rien ne change pour lui, si ce n'est que PACT sait
désormais à quelle étape on est.

**Why this priority**: aucun projet existant ne doit être cassé, et ce suivi est la base du reste.

**Independent Test**: projet sans fichier de workflow ; dérouler une issue avec de faux agents et lire l'étape en cours à chaque événement.

**Acceptance Scenarios**:

1. **Given** un projet sans fichier de workflow, **When** une issue démarre, **Then** PACT utilise le workflow par défaut, sans écrire de fichier
   dans le dépôt.
2. **Given** une issue en cours, **When** un événement de 007 change d'étape, **Then** l'étape en cours est à jour dans le suivi de l'issue.
3. **Given** le workflow par défaut, **When** l'étape PR est atteinte, **Then** c'est la demande de livraison de 008 qui s'exécute.
4. **Given** un projet sans fichier avec des réglages de 008, **When** 010 est livrée, **Then** ces réglages s'appliquent toujours, sans fichier écrit ni action de l'utilisateur.
5. **Given** une étape dont le workflow porte une consigne, **When** elle démarre, **Then** PACT envoie cette consigne, et l'orchestrateur peut ajouter la sienne.

---

### User Story 2 - Composer son workflow à la souris (Priority: P1)

L'utilisateur ouvre l'éditeur. Il ajoute une étape de peaufinage entre la boucle dev ↔ test et la PR, choisit ses agents et leur modèle, règle le
nombre de tours de la boucle, et enregistre.

**Why this priority**: c'est la demande principale.

**Independent Test**: test de composant de l'éditeur ; enregistrer, relire le fichier et le comparer au graphe. Parcours complet au clavier.

**Acceptance Scenarios**:

1. **Given** l'éditeur, **When** l'utilisateur ajoute une étape et la relie, **Then** le graphe et la forme texte montrent le même changement.
2. **Given** une étape, **When** il choisit un rôle et un modèle, **Then** seuls ceux permis par le plafond du rôle sont proposés.
   Un fichier qui nomme un modèle absent ou trop élevé est invalide sur cette machine, avec sa raison.
3. **Given** une boucle dev ↔ test, **When** il règle le nombre maximum de tours, **Then** le réglage s'applique à cette boucle, une fois la PR de l'enregistrement fusionnée.
4. **Given** un graphe invalide (étape isolée, pas d'arrivée, boucle sans plafond), **When** il enregistre, **Then** l'enregistrement est refusé
   avec l'étape en cause.
5. **Given** le clavier seul, **When** il crée et relie une étape, **Then** il y parvient, et un lecteur d'écran annonce le changement.
6. **Given** un workflow valide modifié, **When** il enregistre, **Then** PACT crée une branche et une PR, à relire même Auto activé, et la version courante s'applique jusqu'à la fusion.
7. **Given** un projet sans fichier avec des réglages de 008, **When** il enregistre pour la première fois, **Then** la PR crée le fichier avec ces valeurs ; une fois fusionnée, le fichier fait foi.

---

### User Story 3 - Le workflow se versionne avec le code (Priority: P1)

L'utilisateur modifie la forme texte dans son éditeur, la committe, et la vue graphe le suit. Un collègue la retrouve après un `git pull`.

**Why this priority**: c'est ce qui en fait un fichier de projet et pas un réglage de machine.

**Independent Test**: écrire le fichier dans un dépôt Git temporaire ; vérifier le chargement, l'aller-retour sans perte, et le refus d'un fichier
invalide.

**Acceptance Scenarios**:

1. **Given** un fichier de workflow valide, **When** PACT l'ouvre, **Then** la vue graphe le représente fidèlement.
2. **Given** un workflow, **When** on l'enregistre dans l'éditeur sans rien changer, **Then** le fichier ne change pas.
3. **Given** un fichier invalide, **When** PACT le lit, **Then** il garde la dernière version valide pour les exécutions, et affiche l'erreur avec sa
   ligne.
4. **Given** une issue en cours, **When** le fichier change, **Then** l'issue garde sa version, et le changement s'applique à l'exécution suivante, une fois sur la branche principale.
5. **Given** un fichier avec une étape parallèle ou une condition (seconde phase), **When** PACT de première phase le lit, **Then** il refuse de l'exécuter en le disant clairement, et ne perd rien de son contenu à l'enregistrement.
6. **Given** un fichier sur la branche principale et un réglage local de 008 différent, **When** PACT l'ouvre, **Then** le fichier l'emporte, et PACT dit que le réglage local est ignoré.

---

### User Story 4 - PACT tient les transitions (Priority: P2)

L'orchestrateur tente de passer à la PR alors que le workflow exige un peaufinage : PACT refuse et dit ce qui manque.

**Why this priority**: sans cela, le graphe n'est qu'un dessin ; mais le suivi seul a déjà de la valeur.

**Independent Test**: faux orchestrateur qui tente une transition absente ; vérifier le refus et sa raison.

**Acceptance Scenarios**:

1. **Given** une étape en cours, **When** l'orchestrateur demande une étape non reliée, **Then** PACT refuse avec les étapes possibles.
2. **Given** une boucle au plafond de tours, **When** un défaut arrive, **Then** l'escalade à l'utilisateur de 008 s'applique.
3. **Given** le passage d'une étape à l'autre, **When** il a lieu, **Then** l'orchestrateur en est réveillé par un message `action` de 007.

### Edge Cases

- Un workflow nomme plus d'agents que la limite de 6 : invalide, avec la raison.
- Boucle sans plafond : invalide. Le plafond ne peut pas dépasser la borne de 008.
- Deux étapes d'une même séquence modifient les mêmes fichiers : la règle sans fichiers communs de 004 reste la même.
- Une boucle dev ↔ test qui nomme un seul agent pour les deux rôles : invalide.
- Le fichier change en conflit Git : PACT le signale, et garde la dernière version valide.
- Une étape nomme un CLI non installé : invalide sur cette machine, sans changer le fichier.
- Le fichier vient d'un format plus récent : PACT le refuse, sans l'écraser.
- PACT redémarre : l'étape en cours est restaurée, avec sa version de workflow.
- Une pause de 009 n'avance ni ne recule une étape.
- Le workflow retire une étape pendant qu'une issue y est : la version de démarrage continue de s'appliquer.
- La livraison de 008 revient au dev après une CI rouge : c'est une transition de retour du workflow, pas une nouvelle exécution.

## Requirements *(mandatory)*

### Functional Requirements

**Modèle**

- **FR-001**: Un workflow MUST se composer d'étapes, chacune avec ses agents (rôle, modèle) et une consigne libre, de transitions entre étapes, d'une étape de départ et d'étapes d'arrivée. Les types d'étapes sont les rôles existants (spec,
  design, dev, test, recap), plus peaufinage et PR ; pas d'étape sur mesure.
- **FR-002**: Une boucle MUST être décrite par des transitions, avec un nombre maximum de tours obligatoire.
- **FR-003**: Une transition de première phase MUST réagir à un résultat typé d'étape (fin, verdict `accepted`, verdict `defects`, CI rouge, refus,
  etc.), jamais à une expression libre.
- **FR-004**: Le format MUST porter un numéro de version.
- **FR-005**: La forme texte et le graphe MUST être équivalents : tout ce qui est décrit dans l'un se retrouve dans l'autre, sans perte. La forme texte MUST être déclarative, sans code exécutable. Les positions sont optionnelles, sans influence sur le
  comportement ; l'éditeur MUST ne les écrire que si l'utilisateur déplace un nœud.
- **FR-006**: Le modèle MUST prévoir dès la première phase des groupes d'étapes parallèles et des conditions sur les transitions ; PACT MUST les
  conserver à l'enregistrement, et refuser de les exécuter en le disant, tant que la seconde phase n'est pas livrée.

**Fichier et éditeur**

- **FR-007**: Le workflow MUST vivre dans `.pact/workflow.yaml`, versionnable comme le code et lisible sans PACT : un par projet, nommé pour en permettre plusieurs plus tard. Le fichier de la branche principale à jour fait foi ; un agent MUST ne pas
  pouvoir le changer pour lui-même ; une exécution en cours garde la version de son démarrage.
- **FR-008**: PACT MUST offrir un éditeur visuel pour créer, relier, régler et retirer des étapes, utilisable au clavier et au lecteur d'écran, sur macOS
  et Windows.
- **FR-009**: PACT MUST valider un workflow avant de l'enregistrer ou de l'exécuter, avec une erreur qui nomme l'étape ou la ligne : arrivée inaccessible,
  étape isolée, boucle sans plafond, limite d'agents, modèle ou CLI indisponible, version inconnue.
- **FR-010**: Un fichier invalide MUST ne pas interrompre une exécution en cours, ni être réécrit par PACT.
- **FR-011**: Un projet sans fichier MUST utiliser un workflow par défaut équivalent à la chaîne de 004 et 008, sans écrire dans le dépôt.

**Exécution**

- **FR-012**: PACT MUST tenir, par issue, l'étape en cours et la version du workflow, enregistrées, et les restaurer à un redémarrage.
- **FR-013**: PACT MUST garder l'état, ne permettre que les transitions du workflow, et refuser les autres avec leur raison. L'orchestrateur lance les agents. PACT MUST envoyer la consigne de l'étape écrite dans le workflow, comme 007 FR-021 ; l'orchestrateur ajoute le reste.
- **FR-014**: Les changements d'étape MUST venir des événements de 007 et réveiller l'orchestrateur par un message `action`.
- **FR-015**: L'étape PR MUST exécuter la demande de livraison de 008, sans redéfinir ses barrières ni son déroulé.
- **FR-016**: Dès qu'un fichier existe, il MUST être la seule source du plafond de tours, des passes de peaufinage et du mode de fusion, et les paramètres du projet MUST l'éditer par FR-019 ; le toggle Auto reste local.
- **FR-017**: Les plafonds de modèle du profil de rôle MUST continuer à s'appliquer ; un modèle absent ou trop élevé MUST rendre le workflow invalide sur cette machine, avec sa raison, sans remplacement silencieux.
- **FR-018**: Le skill `pact-orchestrator` MUST lire le workflow du projet, au lieu d'un ordre écrit en dur.
- **FR-019**: Un enregistrement de l'éditeur ou des paramètres du projet MUST créer une branche et une PR, toujours relue par l'utilisateur, même Auto activé, selon les règles de la PR sans verdict de 008. La version courante s'applique jusqu'à sa fusion. Pour un projet sans fichier, ce premier
  enregistrement est le seul geste qui en crée un [NEEDS CLARIFICATION: Q11 — quand aucune PR n'est possible].
- **FR-020**: À la livraison de 010, un projet sans fichier MUST garder ses réglages enregistrés par 008 (mode de fusion, plafond, passes, consigne de peaufinage) comme valeurs de son workflow par défaut, sans rien écrire dans le dépôt. Son premier enregistrement MUST les reprendre dans le fichier ; une
  fois la PR fusionnée, le fichier fait seul foi, et ces valeurs locales ne servent plus. Avec un fichier sur la branche principale, le fichier l'emporte, et PACT MUST dire qu'un réglage local différent est ignoré. La consigne de peaufinage devient la consigne de l'étape de peaufinage.

### Key Entities

- **Workflow** : nom, version du format, étapes, transitions, départ, arrivées.
- **Étape** : identifiant, type, agents (rôle, modèle), consigne, position optionnelle.
- **Transition** : de, vers, résultat qui la déclenche, plafond de tours pour une boucle, condition (seconde phase).
- **Groupe parallèle** (seconde phase) : étapes, règle de jonction.
- **Exécution** : issue, version de workflow, étape en cours, compteurs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un projet existant, sans fichier, se comporte comme avant, sans aucune action de l'utilisateur.
- **SC-002**: Un utilisateur insère une étape de peaufinage et règle un plafond en moins de 2 minutes, à la souris comme au clavier.
- **SC-003**: Un aller-retour texte → graphe → texte d'un fichier valide ne change aucun octet quand rien n'a été modifié.
- **SC-004**: 100 % des fichiers invalides des jeux de test sont refusés, avec l'étape ou la ligne en cause.
- **SC-005**: Un fichier avec des étapes de seconde phase n'est jamais exécuté à moitié, et n'est jamais perdu à l'enregistrement.
- **SC-006**: Après un redémarrage, chaque issue reprend à son étape.

## Assumptions

- Les réglages de 008 et les événements de 007 sont livrés avant le moteur de cette spec.
- Toute dépendance d'éditeur de graphe devra être justifiée au plan (constitution, contraintes techniques).
- La seconde phase fera l'objet de sa propre spec.
- La durée de SC-002 est une proposition de l'agent spec, à confirmer à la relecture.
- « Comme LangGraph » vise le modèle nœuds + transitions + état, pas une dépendance à cette bibliothèque.
