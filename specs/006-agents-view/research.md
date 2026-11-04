# Research: Vue des agents

## R1 — Lignes d'agent à partir des éléments À faire

- **Decision**: `agentRows(workspace, todos)` regroupe les `TodoItem` de `deriveTodos` par `agentId`.
  Les éléments `answer`, `rate-limit`, `review`, `prompt` d'un agent vont sur sa ligne ; l'action
  affichée est celle du premier élément selon `ORDER`. Les éléments `integration-request`,
  `publish-issues`, `loop-escalated`, `overlap`, `usage-limit`, `info` restent des éléments « en
  tête ». Ordre : éléments en tête, puis lignes avec action (ordre `ORDER`), puis l'orchestrateur,
  puis les autres par `position`.
- **Rationale**: `deriveTodos` est déjà la seule source des actions dues (001 FR-028, 003, 004, 005) ;
  regrouper sans recalculer garantit SC-005 (aucune action perdue).
- **Alternatives considered**: recalculer les actions par agent (duplication interdite, IV) ; garder
  deux colonnes (À faire + Agents) : refusé par l'utilisateur (une seule colonne).

## R2 — Colonne

- **Decision**: `AgentsColumn` remplace `TodoColumn` au même emplacement ; en-tête collant
  « Agents N · M à traiter » (M = éléments non `info`, comme le compteur actuel). Une ligne est un
  `li` avec un bouton principal (ouvre le Focus) et, à côté, les boutons d'action de `TodoItem.tsx`
  réutilisés. Le bouton de la barre devient « Agents M ».
- **Rationale**: un bouton principal distinct des boutons d'action évite les boutons imbriqués
  (accessibilité) et garde les actions existantes inchangées.
- **Alternatives considered**: ligne entière cliquable avec boutons dedans (HTML invalide, piège
  clavier).

## R3 — Tuiles sous l'orchestrateur

- **Decision** (révisée après #40, #41, #47) : une seule grille CSS de 3 colonnes au plus, dans un
  conteneur `overflow-y-auto` ; chaque rangée mesure la moitié de la hauteur visible
  (`grid-auto-rows: calc((100% - gap) / 2)` mesurée sur le conteneur), donc 3×2 cases visibles au plus.
  Avec orchestrateur : sa tuile en `col-span-2 row-span-2`, les agents remplissent la colonne de droite
  puis des rangées de 3 (placement automatique de la grille).
  Sans orchestrateur : colonnes = `min(n, 3)` sauf n = 4 (2 colonnes) ; rangées = `ceil(n / colonnes)`
  qui partagent la hauteur tant que n ≤ 6. Une case « + » seulement si la dernière rangée a une place
  libre. Hauteur minimale lisible 120 px vérifiée par `layout.spec` à 1024 × 768.
- **Rationale**: l'orchestrateur pleine largeur sur 3/5 de la hauteur ne laissait pas de place aux
  agents (#41) ; un nombre d'agents borné par les cases visibles empêchait d'en lancer plus de six (#47) ;
  les cases « + » vides gâchaient l'écran avec un seul terminal (#40).
- **Alternatives considered**: orchestrateur pleine largeur sur une rangée (moins de place pour lui) ;
  case « + » toujours présente (rangée vide ajoutée) ; bouton d'ajout dans la barre seulement (choix de
  l'utilisateur : case « + » si place libre).

## R4 — Qui a lancé un agent

- **Decision**: `Agent.launchedBy: string | null` (id de l'orchestrateur, ou `null` = l'utilisateur),
  défaut `null`. `LaunchRequest` accepte `launchedBy` ; seul `launch_agent` le pose. Les agents
  existants restent à `null`.
- **Rationale**: le journal « ◎ Actions » n'est qu'en mémoire ; un champ persisté survit au
  redémarrage (FR-011). Un id plutôt qu'un booléen nomme l'orchestrateur et reste juste si le rôle
  change.
- **Alternatives considered**: déduire du rôle (un agent `dev` peut être lancé à la main) ; persister
  le journal (plus large que le besoin).

## R5 — Issue et phase

- **Decision**: `agentPhase(agent, loops)` : si une boucle référence l'agent (`devAgentId` ou
  `testAgentId`) — la plus récente en cours, sinon la dernière — phase « dev ↔ test N/3 » (`running`),
  « boucle terminée » (`passed`), « boucle arrêtée » (`escalated`), rien (`closed`) ; son issue est
  `loop.issueId`. Sinon, la phase est le rôle (`spec`, `design`, `recap`) ou rien ; pas d'issue.
- **Rationale**: tout est déjà dans `Workspace.loops` et `Agent.role`, mis à jour par
  `workspace:loops` et `agent:state` : pas de nouvel événement.
- **Alternatives considered**: lire l'issue dans la consigne de lancement (fragile, texte libre).

## R6 — Graphe sans dépendance

- **Decision**: `graphLayout(agents, loops)` calcule une grille : orchestrateur en haut au centre ;
  en dessous, un groupe par boucle (dev et test côte à côte, sous l'issue), puis les autres agents
  lancés par l'orchestrateur, puis ceux lancés par l'utilisateur. Positions en fractions de la zone.
  Rendu : nœuds = boutons positionnés (CSS grid), liens = un `svg` `aria-hidden` dessous. Clavier :
  ordre de tabulation = ordre de lecture ; flèches non requises.
- **Rationale**: ≤ 6 nœuds, disposition fixe : une bibliothèque de graphes (dagre, React Flow)
  ajouterait poids et dépendance pour rien (V, YAGNI).
- **Alternatives considered**: React Flow (glisser, zoom : hors périmètre) ; Mermaid (pas
  interactif, accessibilité faible).

## R7 — Audit d'accessibilité

- **Decision**: `@axe-core/playwright` en devDependency ; l'e2e du graphe et de la colonne vérifie
  zéro violation `serious` ou `critical`.
- **Rationale**: SC-006 exige un audit automatique ; axe est la référence, utilisable dans les e2e
  Electron existants.
- **Alternatives considered**: assertions ARIA à la main seulement (ne couvre pas contraste,
  rôles invalides).
