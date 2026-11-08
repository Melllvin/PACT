# Research: Workflow configurable en graphe

Décisions vérifiées contre le code de `origin/main` (`8315ff26`), contre les plans de 007 (`origin/007-agent-exchanges`), de
008 (`origin/008-plan`) et de 009 (`main`). La spec fait foi. Les points encore ouverts sont rassemblés en fin de
document, chacun avec une recommandation ; aucun ne bloque une phase.

## R1 — Base et découpage

- **Decision** : implémentation sur `010-workflow-graph`, depuis `origin/main` une fois 008 fusionnée (ordre conseillé
  de la spec : 007 → 009 → 008 → 010). Une PR par phase, branche `010-phase-N-…` depuis `010-workflow-graph`.
- **Rationale** : l'étape PR est `request_delivery` de 008 ; le plafond, les passes, la consigne de peaufinage et le
  mode de fusion sont `workspace.delivery` de 008 ; le réveil est `ExchangeService` et `WakeService` de 007. Sans eux,
  FR-014, FR-015, FR-016 et FR-020 n'ont pas de voie.
- **Alternatives** : partir de `origin/008-plan` avant la fusion de 008 ; rejeté, les quatre specs touchent
  `workspaceSchema`, `tools.ts` et le skill orchestrateur (spec, « à livrer l'une après l'autre »).

## R2 — Où le graphe remplace ou compose 007, 008 et 009

| Existant | Avec 010 | Nature |
|---|---|---|
| Ordre de la chaîne écrit dans `pact-orchestrator/SKILL.md` (« Chaîne : cadrage → design → boucle → recap ») | lu par `get_workflow` (FR-018) | **remplace** |
| 008 `workspace.delivery.maxRounds`, `polishPasses`, `polishBrief`, `mergeMode` | valeurs du workflow ; `workspace.delivery` ne sert plus que de défauts d'un projet sans fichier (FR-016, FR-020) | **remplace** la source, garde le champ |
| 008 `DeliverySettingsDialog` « Enregistrer » | crée une PR du fichier (FR-019) | **remplace** l'effet |
| 008 toggle Auto (`workspace.delivery.auto`) | inchangé, local | conservé |
| 007 FR-021 : `start_loop` envoie au testeur puis au dev une consigne fixe | la consigne fixe reste, la consigne de l'étape s'y ajoute (Q10, R9) | **compose** |
| 007 journal, `typeOf`, `WakeService` | nouveau kind `stage` (`action`), seule voie de réveil d'un changement d'étape (FR-014) | **compose** |
| 008 `LoopService` (tours, preuve, escalade, `reopen`) | garde le compteur ; le plafond vient du workflow de l'exécution (R7) | **compose** |
| 008 `polish_pass`, état `polishing` | sont l'étape « peaufinage » ; ses passes et sa consigne viennent du workflow | **compose** |
| 008 `request_delivery`, `DeliveryService`, PR sans verdict | sont l'étape « PR » (FR-015) ; l'enregistrement du workflow passe par la PR sans verdict (FR-019) | **compose** |
| 008 escalade au plafond (FR-018) | inchangée, déclenchée au plafond de la transition de retour (US4 sc.2) | **compose** |
| 009 pause `paused`, `usage-*` | ignorés par le moteur : ni avance ni recul (edge case) | neutre |
| 006 vue « Graphe » (agents en direct, lecture seule) | distincte : la vue de 010 s'appelle « Workflow » | séparée |

## R3 — Format du fichier : YAML déclaratif, dépendance `yaml`

- **Decision** : `.pact/workflow.yaml` (Q1), lu et écrit avec la bibliothèque `yaml` (eemeli/yaml, 2.x, licence ISC,
  sans dépendance, maintenue). Version exacte épinglée à la Phase 1 dans `package.json`, comme les autres dépendances.
- **Pourquoi une dépendance** (constitution IV et contraintes techniques) : le projet n'a aucun parseur YAML. Les besoins
  sont précis et non triviaux : (a) ligne et colonne de chaque nœud, pour les erreurs (FR-009, US3 sc.3) ; (b) édition
  d'un document en place qui garde commentaires, ordre et style des parties non touchées (FR-005, FR-006, SC-003,
  SC-005) ; (c) refus des clés en double et des ancres ou étiquettes personnalisées. `yaml` offre `parseDocument`,
  `LineCounter`, `doc.setIn` et `doc.toString()`. Écrire un parseur YAML maison serait plus long et plus risqué.
- **Alternatives** : `js-yaml` (pas d'édition qui garde les commentaires) ; JSON sans dépendance (rejeté par Q1).
- **Restrictions** : `parseDocument(text, { uniqueKeys: true, customTags: [], merge: false, strict: true })` ; ancres,
  alias et étiquettes refusés avec leur ligne : le fichier reste lisible sans PACT et sans surprise (FR-007).
- **Fichier non UTF-8, taille** : au-delà de 64 Kio, refus « fichier trop grand » ; aucune lecture partielle.

## R4 — Modèle : agents du workflow, étapes, transitions

- **Decision** : le workflow déclare ses agents par clé (`agents: { dev: { role: dev, model: … } }`), et chaque étape
  nomme les clés qu'elle emploie. Voir data-model.
- **Rationale** : la spec demande « l'étape et ses agents (rôle, modèle) », la limite de 6 agents et l'invalidité d'une
  boucle dev ↔ test qui « nomme un seul agent pour les deux rôles ». Des clés partagées entre étapes disent qu'une même
  instance passe d'une étape à l'autre (le dev de la boucle est celui du peaufinage, comme 008) ; le compte des agents
  est celui des clés.
- **Types d'étapes** (FR-001, Q7) : `spec`, `design`, `dev`, `test`, `recap`, `polish`, `pr`. Rôles requis :

| Type | Agents requis | Fin de l'étape |
|---|---|---|
| `spec` | 1 `spec` | issue enregistrée `ready` |
| `design` | 1 `design` | maquette validée (événement `mockup`) |
| `test` | 1 `test` | rapport du testeur : tests écrits, `accepted` (avec preuve), `defects` |
| `dev` | 1 `dev` | rapport `done` du dev |
| `polish` | 1 `dev`, 1 `test` | passes finies (008) |
| `pr` | aucun | issue de la livraison (008) |
| `recap` | 1 `recap` | rapport `done` |

## R5 — Résultats typés (FR-003)

- **Decision** : une transition de première phase porte `on: [<résultat>, …]`, pris dans une liste fermée par type
  d'étape. `outcomeOf(stageType, message)` (pur, `src/shared/workflow.ts`) traduit un message du journal de 007 (ou un
  changement d'issue, R8) en résultat.

| Type | Résultats | Source |
|---|---|---|
| `spec` | `ready` | `IssueService.register` → état `ready` |
| `design` | `done` | kind `mockup` validé |
| `test` | `tests-written`, `accepted`, `defects` | 1ᵉʳ rapport du testeur sans verdict ; boucle passée à `accepted`/`polishing` ; `LoopService.next` ou `reopen` |
| `dev` | `done` | rapport `done` du dev |
| `polish` | `done` | boucle de `polishing` à `accepted` |
| `pr` | `merged`, `ci-red`, `tests-failed`, `conflicted`, `user-refused` | kind `delivery`, champ `outcome` (008 R21) |
| `recap` | `done` | rapport `done` |

- **Hors transitions** : `refused` et `dropped` de 008 laissent l'étape PR en cours (la demande est à refaire) ;
  `escalated` (plafond atteint) va à l'utilisateur par 008 FR-018, jamais par une transition (US4 sc.2).
- **Expression libre** : une valeur de `on` hors liste, ou une chaîne dans `when`, rend le fichier invalide avec sa
  ligne (US4 sc.4).

## R6 — Validation (FR-009)

- **Decision** : `validateWorkflow(doc)` pur rend `{ errors: Issue[], phase2: Issue[] }` ; `machineCheck(workflow,
  clis, profiles)` pur rend les erreurs propres à la machine (FR-017, edge cases). Chaque erreur porte `stage?`,
  `line?` et un texte. Règles, dans l'ordre :

1. syntaxe YAML, clés en double, ancres, étiquettes (ligne) ;
2. `version` absente → invalide ; `version` > 1 → « format plus récent (v<n>) : mets PACT à jour », jamais réécrit ;
3. schéma : clés inconnues, types, bornes (`instruction` ≤ 2000, `maxRounds` 1–10 = `MAX_ROUNDS_LIMIT` de 008,
   `passes` 0–5 = `MAX_POLISH`) ;
4. références : clé d'agent, étape de `from`, `to`, `start`, `ends` inconnues ;
5. agents : plus de 6 clés (`MAX_AGENTS`) ; rôles requis de R4 ; une étape `dev` et une étape `test` reliées qui
   nomment la même clé ;
6. résultats : `on` dans la liste de R5 ; deux transitions d'une même étape sur un même résultat (première phase :
   une seule cible par résultat) ;
7. graphe : une étape non atteignable depuis `start` (« étape isolée ») ; une étape d'où aucune arrivée n'est
   atteignable (« arrivée inaccessible ») ; une arrivée qui n'est pas d'un type terminal (`pr`, `recap`, `dev`,
   `design`, `spec`) ;
8. boucles : tout cycle doit contenir une transition à `maxRounds` (Tarjan sur les composantes fortement connexes, puis
   recherche d'un cycle dans la composante privée de ses arêtes plafonnées) ; les transitions plafonnées qui entrent
   dans une même étape portent la même valeur (R7) ;
9. seconde phase : `parallel` non vide ou un `when` objet → `phase2` (« étape parallèle ou condition : prévu en seconde
   phase ») : le fichier est conservé, affiché, enregistrable, jamais exécuté (FR-006, SC-005).

- **Machine** : modèle hors des paliers ou au-dessus de `maxModel` du profil du rôle (`beyondCeiling`, `tierOf` de
  `src/shared/roles.ts`) ; CLI nommé non installé. Invalide « sur cette machine », sans toucher le fichier (Q6).

## R7 — Boucles et plafonds, sans second compteur

- **Decision** : un plafond est porté par une transition de retour (`maxRounds`). Le compteur est celui des entrées
  dans l'étape cible. Pour l'étape `dev` d'une boucle, ce compteur **est** `loop.round` de `LoopService` (008), sans
  copie ; pour tout autre cycle, c'est `run.entries[stageId]`.
- **Comptage** : le défaut `test →(tests-written, defects) dev` avec `maxRounds: 3` dit « 3 tours au plus » : la
  première entrée ouvre le tour 1, chaque `defects` le suivant, et le `defects` du tour 3 escalade (008 FR-018). Le
  retour `pr →(ci-red, tests-failed, conflicted, user-refused) dev` entre dans la même étape : il compte dans les mêmes
  tours, comme 008 (« un nouveau tour compté »). D'où la règle 8 de R6 : même valeur sur les deux.
- **Branchement** : `LoopService` reçoit `maxRounds(workspaceId, issueId)` (dépendance) au lieu de lire
  `workspace.delivery.maxRounds` ; `WorkflowService` le calcule depuis la version de l'exécution. Le passage de
  `maxRounds` à 10 au plus et l'escalade de modèle au dernier tour (004 FR-007) restent ceux de 008.
- **Alternatives** : un compteur par transition dans le moteur ; rejeté (deux compteurs du même tour, constitution IV).

## R8 — Exécution : un état par issue, une version figée

- **Decision** : `WorkflowService` (`src/main/workflow/workflow-service.ts`) tient `workspace.runs[]` (data-model).
  Une exécution naît à l'enregistrement d'une issue (`register_issue`, état `proposed` ou `ready`) sur l'étape
  `start`, avec la version courante du workflow **copiée** dans l'exécution (`workflow` et `oid` du blob). Une issue
  `ready` émet aussitôt `ready` pour l'étape `spec`.
- **Version figée** (FR-007, US3 sc.4, edge case « étape retirée ») : l'exécution ne relit jamais le fichier ; un
  changement s'applique à l'exécution suivante. La copie est bornée (64 Kio du fichier) et persistée : un redémarrage
  la retrouve (FR-012, SC-006).
- **Issue sans exécution** (issues créées avant 010, boucles en cours à la mise à jour) : l'exécution est créée à la
  première action qui la demande, sur l'étape qui correspond à l'état de la boucle (`running` → `test` ou `dev` selon le
  dernier rapport, `polishing` → `polish`, `delivering` → `pr`), avec la version courante.
- **Transition** (FR-013, FR-014) : à chaque message du journal (`ExchangeService.onRecorded`) et à chaque changement
  d'issue, `outcomeOf` donne un résultat ; une transition de l'étape en cours sur ce résultat fait passer à sa cible,
  écrit l'état **avant** tout effet, puis enregistre un message kind `stage` (type `action`, `from: 'pact'`, `to:
  <orchestrateur>`) qui le réveille, et envoie la consigne de l'étape (R9). Un résultat sans transition est ignoré
  (aucun état changé). Une arrivée sur son résultat terminal passe l'exécution à `finished`.
- **Idempotence** : chaque message n'est traité qu'une fois (`run.lastMessageId` et ordre du journal) ; à la reprise
  après un redémarrage, les messages postérieurs à `lastMessageId` sont rejoués.
- **Pause de 009** : `usage-save`, `usage-paused`, `usage-resumed` n'ont aucun résultat (edge case).

## R9 — Consigne d'une étape (FR-013, Q10)

- **Decision** : à l'entrée d'une étape, PACT envoie à chaque agent lié de l'étape une `instruction` de 007 (journal,
  pointeur), dont le texte est : la consigne fixe de PACT pour ce rôle s'il y en a une (007 FR-021 pour `test` et `dev`,
  la phrase fixe de 008 pour `polish`), puis `Consigne du workflow : <instruction>` si l'étape en porte une. Le texte de
  l'étape vient du fichier de la branche principale, relu par l'utilisateur : ce n'est pas du contenu de tiers.
- **Liaison** : une clé d'agent est liée à un agent réel à la première action qui le désigne pour l'issue :
  `start_loop({ issue, dev, test })` lie les clés de l'étape `test` et de l'étape `dev` ; `launch_agent({ role, issue })`
  (paramètre `issue` ajouté, optionnel) lie la clé du rôle de l'étape en cours. Une étape entrée avant la liaison envoie
  sa consigne à la liaison. L'orchestrateur ajoute le reste par `send_prompt` (Q10).
- **Étape `polish`** : la consigne de l'étape remplace `polishBrief` (FR-020) ; les `notes` de `polish_pass` s'y
  ajoutent, comme dans 008 R23.
- **Modèle** : `launch_agent({ role, issue })` prend le CLI et le modèle de la clé du workflow quand ils sont donnés,
  sinon ceux du profil du rôle ; le plafond du profil s'applique toujours (FR-017).

## R10 — Où vit la version qui fait foi (FR-007, Q4)

- **Decision** : la version courante est le blob `.pact/workflow.yaml` de `origin/<main>` après `fetchRefs` (008 R13)
  pour un dépôt avec remote, sinon de `<main>` local. Lecture par `GitService.entry` + `readBlob`, jamais dans un
  worktree : un agent qui modifie le fichier dans sa branche ne change rien tant que ce n'est pas fusionné (« pas pour
  lui-même »).
- **Lecture** : à l'ouverture du workspace, au démarrage de chaque exécution, à l'ouverture de l'éditeur et après chaque
  `fetchRefs` de 008. Rien ne surveille le système de fichiers.
- **Dernière version valide** (FR-010, US3 sc.3) : `workspace.workflow.lastValid = { oid, workflow }` ; un blob
  invalide garde `lastValid` pour les nouvelles exécutions, écrit `workspace.workflow.error` (raison, ligne) et le
  montre. PACT ne réécrit jamais un fichier invalide. Un conflit Git (marqueurs `<<<<<<<`) est une erreur de syntaxe
  avec sa ligne (edge case).
- **Sans fichier** : workflow par défaut (R11), aucune écriture (FR-011, US1 sc.1).

## R11 — Workflow par défaut et reprise des réglages de 008 (FR-011, FR-020)

- **Decision** : `defaultWorkflow(delivery)` pur construit, sans fichier :

```text
spec ──ready──▶ test ──tests-written, defects (≤ maxRounds)──▶ dev ──done──▶ test
test ──accepted──▶ polish ──done──▶ pr ──merged──▶ (fin)
pr ──ci-red, tests-failed, conflicted, user-refused (≤ maxRounds)──▶ dev
```

  avec `maxRounds`, `passes`, la consigne de peaufinage et `mergeMode` lus dans `workspace.delivery`. Agents : `spec`,
  `tester` (`test`), `dev` (`dev`), sans modèle (profil du rôle).
- **Passes à 0** : l'étape `polish` émet `done` dès son entrée (008 : `accepted` sans `polishing`). Le défaut reste
  ainsi équivalent à la chaîne de 004 et 008 (SC-001).
- **Design et recap** : la chaîne de 004 les lance « si besoin » ; sans condition en première phase, ils ne sont pas
  dans le défaut. L'orchestrateur peut toujours lancer un agent `design` ou `recap` hors exécution (`launch_agent` sans
  `issue`), comme aujourd'hui. Voir point ouvert O1.
- **Premier enregistrement** (US2 sc.7) : la PR crée le fichier depuis `defaultWorkflow(delivery)` modifié par
  l'utilisateur. Après sa fusion, le fichier fait seul foi, `workspace.delivery` (hors `auto`) n'est plus lu.
- **Réglage local ignoré** (US3 sc.6) : avec un fichier, `ignoredLocal(delivery, workflow)` liste les réglages de
  `workspace.delivery` différents du fichier ; l'en-tête de l'éditeur et le dialogue de livraison le disent.

## R12 — Enregistrement : branche et PR (FR-019, Q9, Q11)

- **Decision** : `WorkflowSaver` (`src/main/workflow/workflow-saver.ts`) :
  1. valide (R6, sans erreur hors `phase2`) ; aucun changement de modèle → aucune écriture (SC-003, US3 sc.2) ;
  2. `fetchRefs` de la cible ; sérialise par `writeWorkflow(base, model)` (R13) sur le blob de la cible ;
  3. écrit un commit sur une branche `pact/workflow-<horodatage>` partant de la cible, **sans worktree** :
     `writeBlob`, `replaceInTree`, `commitWithHooks` (réutilisés de `IntegrationService`), hooks vides ;
  4. remet la branche à 008 comme une **PR sans verdict** : `DeliveryService.requestUnverified({ branch, title,
     message, source: 'workflow' })`. Sans verdict, Auto n'a pas d'effet : relecture toujours demandée (US2 sc.6).
- **Sans remote** (Q11, US2 sc.8) : même commit, puis l'élément `delivery-local` de 008 « Fusionner sans verdict »,
  confirmé par l'utilisateur.
- **Remote non GitHub ou `gh` absent** (US2 sc.9) : refus avant tout commit, avec la raison de `GhClient.availability`
  (008 R8) et « Modifie `.pact/workflow.yaml` avec Git ». L'éditeur et les réglages restent lisibles.
- **Changement à 008** : `Delivery.agentId` devient nullable avec `source: 'agent' | 'workflow'` ; une demande
  `workflow` n'a ni boucle, ni compteur, ni nettoyage de worktree (aucun worktree) ; à la fusion, PACT relit la version
  courante (R10). `IntegrationService.start` accepte une branche sans agent pour la voie locale.
- **Une seule à la fois** : un enregistrement tant qu'une demande `workflow` non finale existe est refusé (« Une PR du
  workflow attend ta relecture : #<n> »).

## R13 — Aller-retour sans perte (FR-005, FR-006, SC-003, SC-005)

- **Decision** : le modèle n'est jamais régénéré en entier. `writeWorkflow(text, next)` part du `Document` du texte
  d'origine et n'applique que les différences champ par champ (`setIn`, `deleteIn`, ajout en fin de séquence) ; les
  nœuds inconnus du modèle de première phase (`parallel`, `when`) ne sont jamais touchés.
- **Sans changement** : `equalWorkflows(a, b)` sur le modèle canonique → aucune écriture, octet pour octet.
- **Positions** (Q8) : `stage.position` n'est écrit que pour une étape que l'utilisateur a déplacée dans l'éditeur ;
  l'éditeur garde un ensemble `moved` en mémoire, vidé à l'enregistrement.
- **Création** (aucun texte d'origine) : sérialisation déterministe, ordre fixe des clés (data-model), sans positions.
- **Test de propriété** : pour chaque fichier de `tests/fixtures/workflows/valid/*.yaml`, `writeWorkflow(t,
  parse(t)) === t`, et après un changement, seules les lignes du champ changé diffèrent.

## R14 — Éditeur : sans bibliothèque de graphes

- **Decision** : vue « Workflow » (`src/renderer/workflow/`), quatrième choix de la barre « Vues » à côté de Tuiles et
  Revue (« Graphe » de 006 garde son nom). Trois zones : liste des étapes (gauche), graphe (centre), panneau de l'étape
  choisie et forme texte en lecture (droite). Même rendu que 006 R6 : nœuds = boutons positionnés, liens = `svg`
  `aria-hidden` dessous.
- **Disposition automatique** : `workflowLayout(workflow)` pur : couches par plus long chemin depuis `start` sur le
  graphe privé des transitions plafonnées, ordre dans la couche par ordre du fichier, retours dessinés en arc. Une étape
  avec `position` la garde. ≤ 6 agents et une dizaine d'étapes : aucune bibliothèque (dagre, React Flow) n'est
  justifiée (constitution V, comme 006 R6).
- **Clavier et lecteur d'écran** (FR-008, US2 sc.5) : tout geste de la souris a son équivalent dans le panneau :
  « Ajouter une étape » (type), « Relier à… » (liste des étapes, résultats en cases à cocher), « Retirer », champs du
  plafond, des passes, de la consigne, du rôle et du modèle. Flèches pour se déplacer entre nœuds ; `Alt+flèches`
  déplace le nœud choisi (écrit sa position). Région `aria-live="polite"` qui annonce chaque changement (« Étape
  Peaufinage ajoutée, reliée depuis Test sur accepted »).
- **Glisser** : `pointerdown/move/up` sur le nœud, grille de 8 px ; aucun glisser pour relier en première phase (le
  lien se fait dans le panneau : un seul chemin, accessible).
- **Forme texte** : `<pre>` en lecture, produit par `writeWorkflow` à chaque changement, avec la ligne changée mise en
  évidence. L'édition du texte se fait dans l'éditeur de l'utilisateur, puis Git (US3).
- **Modèles proposés** : seulement ceux de `modelTiers` du CLI jusqu'au `maxModel` du profil (US2 sc.2).

## R15 — Outils de l'orchestrateur (FR-013, FR-018, US4)

- **Decision** : deux outils, et une barrière sur trois outils existants.
  - `get_workflow({ issue? })` : le workflow (version courante ou de l'exécution), l'étape en cours, les étapes
    possibles avec leurs résultats, les compteurs. Remplace l'ordre écrit dans le skill (FR-018).
  - `advance_stage({ issue, to })` : seulement le long d'une transition dont le résultat est `done` (ou `ready`) sur une étape `spec`,
    `design` ou `recap` que l'orchestrateur a faite lui-même (aucun agent lié) ; refus sinon. L'orchestrateur ne peut
    pas déclarer `accepted`, `defects`, `merged` ni une CI : ces résultats viennent de PACT (sécurité de la boucle de
    004).
  - `start_loop`, `polish_pass`, `request_delivery` vérifient que l'étape en cours (ou la cible d'une transition depuis
    elle) est du type attendu ; sinon `Refusal` : « Étape en cours : <x>. Étapes possibles : <y> (sur <résultats>). »
    (US4 sc.1).
- **Alternatives** : un outil unique `enter_stage` libre ; rejeté, il laisserait l'orchestrateur sauter une barrière.

## R16 — Skill orchestrateur (FR-018, US4 sc.5)

- **Decision** : la section « Chaîne : cadrage → design → boucle → recap » de `resources/skills/pact-orchestrator/SKILL.md`
  devient « Workflow » : « appelle `get_workflow` ; suis l'étape en cours ; à chaque message `stage`, lance ou relance
  les agents de l'étape ; un refus de PACT donne les étapes possibles ». Le test de contenu interdit tout ordre de
  chaîne écrit en dur (« cadrage → design → boucle »).

## R17 — Fichier modifié par un agent

- **Decision** : la barrière de 008 (`deliveryGate`) ajoute : une livraison dont le diff touche `.pact/workflow.yaml`
  n'est jamais fusionnée par Auto (relecture forcée, raison « modifie le workflow »). Sans quoi un agent pourrait
  changer le workflow des exécutions suivantes sans relecture, ce que Q4 et Q9 excluent.
- Voir point ouvert O3.

## R18 — Constantes

| Nom | Valeur | Source |
|---|---|---|
| `WORKFLOW_PATH` | `.pact/workflow.yaml` | Q1 |
| `WORKFLOW_FORMAT` | 1 | FR-004 |
| `MAX_WORKFLOW_BYTES` | 65 536 | R3 |
| `MAX_STAGES` | 20 | lisibilité de l'éditeur |
| `MAX_STAGE_INSTRUCTION` | 2 000 | = `MAX_POLISH_BRIEF` de 008 |
| `MAX_RUN_HISTORY` | 50 | data-model |
| `MAX_ROUNDS_LIMIT`, `MAX_POLISH` | 10, 5 | 008 R25 |
| `MAX_AGENTS` | 6 | 001 |

## Points ouverts (non bloquants, recommandation donnée)

- **O1 — Design et recap dans le défaut** : la chaîne de 004 les fait « si besoin », ce que la première phase ne sait
  pas dire sans condition. **Recommandation** : hors du défaut ; un projet qui les veut les ajoute dans l'éditeur.
  L'orchestrateur garde le droit de lancer `design` ou `recap` hors exécution, comme aujourd'hui.
- **O2 — Étape `spec` et issues** : l'agent spec écrit plusieurs issues d'un coup, avant que chaque exécution existe.
  **Recommandation** : l'exécution naît à `register_issue` ; l'étape `spec` se termine quand l'issue est `ready`. La
  consigne d'étape `spec` part donc au lancement d'un agent `spec` (`launch_agent({ role: 'spec' })`), au niveau du
  workspace, une fois.
- **O3 — Workflow modifié dans la branche d'un agent** : la spec dit seulement qu'un agent ne peut pas le changer
  « pour lui-même ». **Recommandation** : R17, relecture forcée de toute livraison qui touche le fichier, sans refus.
- **O4 — Édition du texte dans PACT** : la spec demande l'équivalence, pas un éditeur de texte. **Recommandation** :
  forme texte en lecture dans PACT (aucune dépendance d'éditeur de code) ; l'édition se fait avec l'outil de
  l'utilisateur et Git (US3).
- **O5 — Durée de SC-002** (spec, Assumptions) : 2 minutes à confirmer. **Recommandation** : la garder ; l'e2e us66
  mesure le parcours clavier sur le faux CLI, sans seuil de temps dans la CI (trop dépendant de la machine), et
  `quickstart.md` donne le parcours chronométré à la main.
- **O6 — Arrivées** : la spec dit « étapes d'arrivée » sans les typer. **Recommandation** : toute étape peut être une
  arrivée, sauf `test` et `polish`, dont la fin mène toujours ailleurs ; une arrivée `pr` finit sur `merged`, les
  autres sur `done` ou `ready`.
- **O7 — Qui lance l'étape PR** : US1 sc.3 dit que « la demande de livraison de 008 s'exécute » à l'étape PR, et 008
  Q11 veut un titre et un message donnés dans la demande. **Recommandation** : le message `stage` réveille
  l'orchestrateur, qui appelle `request_delivery` avec son titre et son message ; PACT ne la lance pas seul. Le bouton
  « Livrer » de l'utilisateur reste possible à la même étape.
