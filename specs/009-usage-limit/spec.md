# Feature Specification: Arrêt à une limite de consommation

**Feature Branch**: `007-010-specs`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "009-usage-limit : arrêt à une limite. Seuil par fenêtre exposée par le CLI (5 h et semaine pour
Claude ; pas de fenêtre journalière), 90 % par défaut, réglable. À seuil − 3 points : PACT demande aux agents de committer et
pousser. Au seuil : PACT arrête tous les agents, marqués en pause. Reprise au reset avec --resume. La consigne de sauvegarde doit
arriver à un agent en plein tour : à concevoir avec 007. Lecture de jauge trop ancienne : proposer un arrêt par prudence, en
[NEEDS CLARIFICATION] pour validation. Part de src/main/usage et de la reprise auto existante (auto-resume.ts)."

## Contexte

La jauge de 005 montre et alerte, sans jamais arrêter. La reprise automatique (001, `auto-resume.ts`) n'agit qu'après coup, sur une
erreur de limite. Constats dans le code au moment de cette spec :

- Une lecture n'arrive que par l'activité des agents (`UsageService.record`) : quand tous les agents sont arrêtés, plus rien ne la
  rafraîchit ; seule l'heure de réinitialisation permet de conclure (`currentWindow`).
- `usageAlert` ne dit plus rien pour une lecture de plus de 60 minutes (`HIDDEN_MINUTES`) : la protection tomberait là où le risque
  est le plus grand.
- `resetAt` rend la réinitialisation de la fenêtre la plus chargée : quand deux fenêtres dépassent le seuil, reprendre à la première
  ferait repartir l'agent pour le réarrêter aussitôt.
- La reprise (`resumeDue`) n'accepte que `state: error` et `kind: rate-limit`. Il n'y a pas d'état « en pause », et `restore` marque
  « à reprendre » tout agent sans processus après un redémarrage.
- `--resume` rouvre la session et attend à l'invite : un agent arrêté en plein tour ne repart pas de lui-même.
- La règle `Bash(git push *)` est sensible (`claude-code.ts`, niveau « Actions sensibles ») : la consigne de pousser peut arrêter
  l'agent sur une question à l'utilisateur.

## Références UI

Pas de maquette dédiée. Le seuil s'ajoute aux réglages de seuils de 005 (`renderer/settings/UsageThresholds.tsx`). L'état « en pause »
utilise les couleurs d'état existantes, avec un label court et l'heure de reprise. L'avertissement passe par la zone d'action de
l'utilisateur. Libellés : `docs/maquettes/CONSIGNES-UI.md`.

## Dépendances

- **Prérequis** : 005 (lectures), 001 (reprise automatique, `--resume`), 007 (consigne en plein tour, réveil à la reprise, plafond de
  réveils).
- **Sans dépendance à 008** : une PR déjà ouverte continue d'être suivie pendant la pause, puisque cela ne consomme aucun agent.

## Périmètre

**Inclus** : un seuil par fenêtre exposée ; la consigne de sauvegarde à seuil − 3 points ; l'arrêt au seuil ; l'état « en pause » ; la
reprise au reset avec `--resume` ; la proposition d'arrêt sur une lecture trop ancienne.

**Hors périmètre** :

- Une fenêtre journalière : le CLI n'en expose pas.
- Un coût en euros, une limite par clé d'API (005).
- Le basculement automatique vers un autre CLI ou un autre modèle.
- Les CLI qui n'exposent pas leur consommation : sans lecture, PACT n'arrête rien.

## Clarifications

### Session 2026-11-05

Décisions données par l'utilisateur avec la demande, à ne pas rouvrir :

- Q: Quel seuil ? → A: un par fenêtre exposée par le CLI (5 h et semaine pour Claude, pas de fenêtre journalière), 90 % par défaut,
  réglable.
- Q: Quand sauvegarder ? → A: à seuil − 3 points, PACT demande aux agents de committer et pousser.
- Q: Quand arrêter ? → A: au seuil, PACT arrête tous les agents, marqués en pause.
- Q: Quand reprendre ? → A: au reset, avec `--resume`.
- Q: Et un agent en plein tour ? → A: la consigne doit lui arriver, à concevoir avec 007.
- Q: Sur quoi se bâtir ? → A: `src/main/usage` et la reprise automatique existante.

Le passage `speckit-clarify` n'a interrogé personne, à la demande de l'utilisateur : ce qui reste ouvert est listé sous « Questions
ouvertes » et marqué [NEEDS CLARIFICATION] là où il joue.

## Questions ouvertes

Chaque question porte une proposition de l'agent spec. Aucune n'est décidée.

- **Q1 — Lecture trop ancienne : à valider** (demandé par l'utilisateur). *Proposition* : si la dernière lecture a plus de 15 minutes
  (`STALE_MINUTES`), qu'au moins un agent travaille et que le dernier pourcentage connu est à 10 points du seuil ou moins, PACT propose
  à l'utilisateur d'arrêter par prudence. Il n'arrête pas seul. Sans décision, il repropose à chaque palier de 15 minutes.
- **Q2 — Qui arrête-t-on ?** « Tous les agents » : tous ceux du compte à la limite, ou tous ceux de PACT ? Un agent Codex n'est pas touché
  par la limite d'un compte Claude. *Proposition* : tous les agents du compte concerné, dans tous les workspaces ouverts.
- **Q3 — Comment pousser sans bloquer sur une autorisation ?** Au niveau « Actions sensibles », un `git push` de l'agent pose une question,
  à laquelle personne ne répond peut-être. *Proposition* : l'agent ne fait que committer ; PACT pousse lui-même sa branche, puis attend le
  seuil ; un échec de push est signalé, sans bloquer l'arrêt ; sans remote, le commit suffit.
- **Q4 — Et les fenêtres par modèle (« semaine · Opus ») ?** 005 les lit quand le CLI les donne. *Proposition* : elles ont leur seuil comme
  les autres, et l'arrêt reste par compte, pour rester simple.
- **Q5 — Reprise et réglage de reprise automatique.** Le réglage existant `autoResume` fait partie des préférences d'autorisation, qu'un projet peut remplacer. Coupé, faut-il reprendre au reset ? Et
  sans heure de réinitialisation ? *Proposition* : coupé, l'agent reste en pause avec un bouton « Reprendre » ; sans heure connue, l'attente
  croissante existante s'applique ; à la reprise, l'orchestrateur repart d'abord.
- **Q6 — Bornes et portée du réglage.** Par CLI, par compte, global ? *Proposition* : un réglage par CLI et par fenêtre, de 10 à 100 %. Un
  seuil à 100 % ne protège pas d'une erreur de limite, et le niveau `critical` de 005 (95 %) ne sera plus vu : les deux restent inchangés,
  l'interface le signale.
- **Q7 — Reprise manuelle au-dessus du seuil, et nouveaux lancements.** L'utilisateur peut vouloir finir un travail. *Proposition* :
  « Reprendre » reste possible et vaut dérogation jusqu'au prochain reset ; `launch_agent` est refusé pendant la pause ; le lanceur de
  l'utilisateur avertit (005) sans bloquer.
- **Q8 — Lecture qui saute par-dessus la bande de sauvegarde.** Une lecture peut passer de 85 à 92 %. La demande arrête au seuil, mais la
  sauvegarde n'a pas eu lieu. *Proposition* : consigne immédiate, puis arrêt après 60 secondes au plus.
- **Q9 — Et le non-commité d'un agent qui n'a pas répondu ?** *Proposition* : PACT ne committe rien à sa place : le worktree reste en l'état,
  et l'agent est marqué « non sauvegardé », pour que l'utilisateur le sache.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - PACT s'arrête au seuil, sans perte (Priority: P1)

Trois agents travaillent, la fenêtre de 5 h monte. À 87 %, ils reçoivent la consigne de sauvegarder, même en plein tour. À 90 %, PACT les arrête,
et leurs tuiles indiquent « en pause, reprise à 16:40 ». L'utilisateur retrouve le travail commité.

**Why this priority**: c'est l'objet de la spec : atteindre la limite en plein tour perd le contexte et laisse des worktrees incohérents.

**Independent Test**: faux CLI et lectures injectées dans le service d'usage ; vérifier la consigne à 87, l'arrêt à 90, l'état et l'absence
d'erreur.

**Acceptance Scenarios**:

1. **Given** un seuil à 90 %, **When** une lecture atteint 87 % sur une fenêtre, **Then** PACT demande une seule fois à chaque agent concerné,
   pour cette fenêtre et jusqu'à son reset, de committer et pousser.
2. **Given** un agent inactif, **When** la consigne part, **Then** il la reçoit dans son invite, sans passer sur une saisie de l'utilisateur.
3. **Given** un agent en plein tour, **When** la consigne part, **Then** elle lui arrive par la voie de 007, à sa prochaine fin d'outil.
4. **Given** une lecture à 90 %, **When** PACT la reçoit, **Then** il arrête les agents concernés, qui sont en pause et non en erreur.
5. **Given** un seuil par fenêtre, **When** la semaine atteint son seuil avant la fenêtre de 5 h, **Then** l'arrêt a lieu, et la pause nomme la
   semaine.
6. **Given** un agent sans réponse à la consigne, **When** le seuil est atteint, **Then** il est arrêté quand même
   [NEEDS CLARIFICATION: Q9 — non-commité].

---

### User Story 2 - La reprise au reset (Priority: P1)

À l'heure de réinitialisation, les agents repartent dans leur session, et ceux qui étaient en plein tour sont réveillés pour continuer.

**Why this priority**: sans reprise, un arrêt la nuit coûte toute la nuit de travail.

**Independent Test**: horloge pilotée (`Clock` de `auto-resume.ts`) et faux CLI ; vérifier `--resume`, le pointeur, et le cas de deux fenêtres.

**Acceptance Scenarios**:

1. **Given** des agents en pause sur la fenêtre de 5 h, **When** l'heure de réinitialisation arrive, **Then** chacun repart avec `--resume` dans
   sa session.
2. **Given** deux fenêtres au-dessus du seuil, **When** la première se réinitialise, **Then** PACT attend la seconde.
3. **Given** un agent arrêté en plein tour, **When** il a repris, **Then** PACT lui transmet un pointeur pour continuer ; un agent inactif avant
   l'arrêt n'est pas relancé.
4. **Given** PACT redémarré pendant une pause, **When** il rouvre, **Then** les agents restent en pause, la reprise est réarmée, et ils ne passent
   pas en « à reprendre ».
5. **Given** une session sans identifiant connu, **When** la reprise est due, **Then** l'agent reste en pause, avec le moyen de le relancer.

---

### User Story 3 - Une lecture trop ancienne (Priority: P2)

Les agents travaillent, mais la jauge n'a rien lu depuis un moment. PACT ne sait plus où en est la limite. Il propose d'arrêter par prudence.

**Why this priority**: c'est le cas où la protection serait aveugle, mais il dépend de la validation de la règle.

**Independent Test**: lectures vieillies avec l'horloge pilotée, agents actifs ou non.

**Acceptance Scenarios**:

1. **Given** une lecture trop ancienne et des agents actifs, **When** la règle s'applique, **Then** PACT propose à l'utilisateur d'arrêter par
   prudence [NEEDS CLARIFICATION: Q1 — règle à valider par l'utilisateur].
2. **Given** cette proposition, **When** l'utilisateur la refuse, **Then** rien n'est arrêté, et la proposition revient selon la règle.
3. **Given** cette proposition, **When** l'utilisateur l'accepte, **Then** les agents reçoivent la consigne de sauvegarde puis l'arrêt, comme au
   seuil.
4. **Given** aucun agent actif, **When** la lecture vieillit, **Then** rien n'est proposé.

---

### User Story 4 - Régler le seuil (Priority: P3)

L'utilisateur baisse le seuil de la semaine à 80 % pour garder de la marge.

**Why this priority**: 90 % convient à la plupart des cas.

**Independent Test**: test de composant et test de service sur le changement de seuil.

**Acceptance Scenarios**:

1. **Given** les réglages, **When** l'utilisateur les ouvre, **Then** il voit un seuil par fenêtre exposée, à 90 % par défaut.
2. **Given** un seuil baissé sous la consommation courante, **When** il l'enregistre, **Then** PACT applique aussitôt sauvegarde puis arrêt.
3. **Given** un seuil relevé au-dessus de la consommation pendant une pause, **When** il l'enregistre, **Then** les agents reprennent.

### Edge Cases

- Plusieurs agents en plein tour : un long outil retarde la consigne (007) ; le seuil les arrête quand même.
- L'arrêt survient pendant un `git commit` : un verrou Git peut rester. La reprise doit le constater et le dire, pas l'effacer en aveugle.
- Un agent qui attend une réponse de l'utilisateur ne reçoit pas la consigne ; l'arrêt ferme sa question, et À faire le dit.
- L'agent passe en erreur de limite avant l'arrêt : la reprise existante et la pause ne se doublent pas.
- Le plafond de réveils de 007 est atteint : la consigne de sauvegarde passe quand même (007 FR-017).
- Une lecture revient en arrière après un changement de compte : le dernier relevé prime, et la consigne n'est redonnée qu'après un reset.
- La consommation vient aussi d'une session hors de PACT : la lecture est au niveau du compte, l'arrêt peut survenir sans activité visible.
- Un test lancé par PACT ou une PR suivie (008) continue pendant la pause, et l'événement attend la reprise de l'orchestrateur.
- Une boucle en pause ne compte ni tour, ni rapport manquant.
- Les terminaux libres ne sont pas des agents : ils ne s'arrêtent pas.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: PACT MUST offrir un seuil pour chaque fenêtre exposée par le CLI, à 90 % par défaut, réglable, enregistré
  [NEEDS CLARIFICATION: Q4 — fenêtres par modèle ; Q6 — portée et bornes].
- **FR-002**: PACT MUST évaluer chaque fenêtre à chaque lecture, en tenant compte de sa réinitialisation. La fenêtre la plus chargée seule ne suffit
  pas.
- **FR-003**: À seuil − 3 points sur une fenêtre, PACT MUST demander aux agents concernés de committer et pousser, une fois par fenêtre et par reset
  [NEEDS CLARIFICATION: Q2 — agents concernés ; Q3 — push].
- **FR-004**: La consigne MUST arriver à un agent en plein tour par la voie de 007, et rester transmissible malgré le plafond de réveils.
- **FR-005**: Au seuil, PACT MUST arrêter les agents concernés, et les marquer « en pause », état distinct d'une erreur, avec la fenêtre et l'heure de
  reprise [NEEDS CLARIFICATION: Q8 — saut de la bande de sauvegarde ; Q9 — non-commité].
- **FR-006**: L'état « en pause » MUST survivre à un redémarrage de PACT, reprise réarmée.
- **FR-007**: Au reset, PACT MUST reprendre chaque agent avec `--resume`, en réutilisant la reprise existante, et seulement quand toutes les fenêtres
  au-dessus du seuil sont réinitialisées [NEEDS CLARIFICATION: Q5 — réglage coupé, heure inconnue, ordre].
- **FR-008**: Après la reprise, un agent arrêté en plein tour MUST recevoir un pointeur pour continuer ; un agent inactif MUST ne pas être relancé.
- **FR-009**: Sur une lecture trop ancienne, PACT MUST proposer un arrêt par prudence à l'utilisateur, et MUST ne pas arrêter de lui-même
  [NEEDS CLARIFICATION: Q1 — règle à valider par l'utilisateur].
- **FR-010**: PACT MUST permettre à l'utilisateur d'annuler une reprise prévue, et de reprendre à la main
  [NEEDS CLARIFICATION: Q7 — dérogation au seuil, lancements pendant la pause].
- **FR-011**: Un CLI sans lecture de consommation MUST ne jamais être arrêté par cette règle.
- **FR-012**: La pause MUST ne consommer ni tour de boucle, ni rapport manquant, et l'orchestrateur MUST en être informé à la reprise.
- **FR-013**: Chaque consigne, arrêt et reprise MUST figurer au journal de 007, avec la fenêtre et le pourcentage.

### Key Entities

- **Seuil de fenêtre** : CLI, fenêtre, pourcentage.
- **Pause** : agent, compte, fenêtres en cause, heure de reprise, en plein tour ou non, sauvegarde constatée ou non.
- **Consigne de sauvegarde** : compte, fenêtre, reset qu'elle vise, agents touchés.
- **Proposition d'arrêt par prudence** : âge de la lecture, dernier pourcentage connu, décision de l'utilisateur.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sur tous les scénarios de test, aucun agent suivi n'atteint le seuil sans être arrêté dans les 5 s qui suivent la lecture.
- **SC-002**: Un agent qui répond à la consigne a son travail commité avant l'arrêt, dès qu'une bande de 3 points a été lue.
- **SC-003**: Un agent en pause n'est jamais présenté comme en erreur, même après un redémarrage de PACT.
- **SC-004**: La reprise a lieu dans la minute qui suit le reset de la dernière fenêtre en cause, sans geste de l'utilisateur.
- **SC-005**: Après reprise, un agent interrompu en plein tour repart sans qu'on lui retape sa consigne.
- **SC-006**: PACT n'arrête jamais un agent sur une lecture trop ancienne sans l'accord de l'utilisateur.

## Assumptions

- La bande de 3 points est décidée. Elle peut se traverser en une lecture, d'où Q8.
- Les heures de réinitialisation viennent des lectures de 005 ; sans elles, l'attente croissante de `auto-resume.ts` s'applique.
- Les seuils `warn` et `critical` de 005 restent tels quels : ils alertent, celui-ci arrête.
- `autoResume` est lu au niveau existant (`permissionPreferenceSchema`).
- Les tests utilisent le faux CLI et une horloge pilotée.
- Les durées des critères de succès sont des propositions de l'agent spec, à confirmer à la relecture.
