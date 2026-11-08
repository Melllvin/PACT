# Research: Arrêt à une limite de consommation

Décisions vérifiées contre le code de `origin/main` (`a5321df0`) et de `origin/007-agent-exchanges` (`063724eb`).

## R1 — L'état « en pause »

- **Decision** : un nouvel état `paused` dans `agentStateSchema`, et un champ `Agent.pause`, à `null` hors pause (data-model). `pause` porte le compte, les fenêtres en cause et leur pourcentage, l'heure de reprise, `midTurn` et `saved`.
- **Rationale** : SC-003 interdit de présenter la pause comme une erreur. Une erreur `rate-limit` avec un drapeau serait lue comme une erreur par `agentStateLabel`, `markStale`, `inError`, `WORKING_STATES` et `deriveTodos`. Un état propre force chaque lecteur à le traiter. `applySignal` ignore tout signal en `paused`, comme en `closed`, puisque le processus est arrêté.
- **Alternatives** : `state: 'error'` avec `lastError.kind: 'usage-limit'`, rejeté par SC-003 ; `state: 'closed'`, rejeté car la fermeture retire l'agent des lectures et des `unreadBy` (007).

## R2 — Les seuils

- **Decision** : `appState.usageStops: Record<cliId, Record<windowId, number>>`, entiers de 10 à 100. Une fenêtre absente vaut `DEFAULT_STOP = 90`. Les fenêtres affichées sont celles des lectures de ce CLI, fenêtres par modèle comprises. Pour Claude Code, `five-hour` et `week` s'affichent aussi avant toute lecture.
- **Rationale** : FR-001 veut un réglage par CLI et par fenêtre, enregistré. Les `id` de fenêtre existent déjà (`claude-statusline.ts` : `five-hour`, `week`, `seven_day_opus`…). Le même emplacement que `usageThresholds` ne demande aucun nouveau fichier.
- **Alternatives** : un seuil global, rejeté par Q6 ; un seuil par compte, que la spec ne demande pas (YAGNI).

## R3 — L'évaluation par fenêtre

- **Decision** : `limitBands(reading, stops, now)` pure, dans `src/shared/usage-limit.ts`. Elle lit chaque fenêtre par `currentWindow`, donc une fenêtre dont le reset est passé vaut 0 %. Chaque fenêtre est classée `ok`, `save` (pourcentage ≥ seuil − 3) ou `stop` (pourcentage ≥ seuil). Le résultat donne la liste des fenêtres en `stop` et en `save`.
- **Rationale** : FR-002 refuse la seule fenêtre la plus chargée. `resetAt` et `shownWindow` ne regardent qu'une fenêtre ; ils restent pour la jauge.
- **Seuil bas** : à 10 %, la bande commence à 7 %. Un seuil de 100 donne une bande à 97.

## R4 — `UsageLimitService`

- **Decision** : un service, `src/main/usage/usage-limit-service.ts`, abonné aux `usage:state` de `UsageService`. Il évalue, envoie les consignes, arrête, prépare la reprise et tient la proposition par prudence. Ses dépendances sont injectées : `agents` (sous-ensemble de `AgentManager`), `exchanges`, `wake`, `git`, `stores.state`, `clock`, `autoResume(workspaceId)`, `commitFrozen(agentId)`.
- **Rationale** : constitution IV et V. `UsageService` n'agit sur rien aujourd'hui ; lui donner des minuteries et des arrêts mélangerait lecture et décision. Le service reste testable seul, avec une horloge pilotée (`Clock` de `auto-resume.ts`).
- **Alternatives** : tout dans `AgentManager`, rejeté pour sa taille ; dans `UsageService`, rejeté ci-dessus.

## R5 — La consigne de sauvegarde

- **Decision** : à l'entrée d'une fenêtre en `save`, le service écrit un message `usage-save`, de `pact`, type `action`, dans le journal du workspace de chaque agent concerné (R7). Le texte vient de `saveText` (contrats). Puis il appelle `wake.deliver(agentId, { urgent: true })`.
- **En plein tour** : `takeForHook` de 007 applique le plafond et la coupure, même pour une consigne urgente. 009 y ajoute une règle : un pointeur dont les messages en attente comptent un `usage-save` passe outre le plafond et la coupure. Cela vaut pour `attempt` comme pour `takeForHook` (FR-004, 007 FR-017). Le pointeur reste celui de 007 et ne contient aucun mot de la consigne.
- **Une fois par reset** : `usageLimit.saves` garde, par `cliId`, compte et fenêtre, le `resetsAt` visé. Une nouvelle consigne ne part qu'après ce reset. Une lecture qui revient en arrière ne la redonne donc pas (spec, cas limites). Le champ est persisté : un redémarrage ne la redonne pas non plus.
- **Exclus** : un agent dont `commitFrozen` est vrai ne reçoit rien (FR-003, Q10) ; un agent `awaiting-answer` reçoit le message, mais 007 retient le pointeur, conformément à la spec ; les agents `error`, `closed` et `paused` sont ignorés.
- **Pas de push** : le texte dit « commit local, sans push ». PACT n'exécute aucune commande Git d'écriture. Le test SC-007 compare les refs d'un remote nu avant et après.

## R6 — L'arrêt

- **Decision** : à l'entrée d'une fenêtre en `stop`, sans dérogation (R10), le service arrête les agents concernés. `AgentManager.pause(id, pause)` lit `midTurn` (`WORKING_STATES` avant l'arrêt). Il appelle `stop(id)`, qui tue le processus sans le compter comme un crash. Il mesure `saved` par `git.hasUncommittedChanges(worktreePath)` après l'arrêt, puis enregistre `state: 'paused'` et `pause`.
- **Délai** : si la consigne de cette fenêtre est partie avant cette lecture, l'arrêt est immédiat (SC-001 : 5 s). Si la lecture saute la bande (Q8), la consigne part aussitôt. Chaque agent est arrêté à la fin de son tour (`turn-finished`), ou au plus tard 60 s après la consigne (point ouvert O5).
- **Non sauvegardé** : `saved: false` dès qu'il reste des changements. PACT ne committe rien (Q9). Un agent figé par 008 et avec des changements est aussi `saved: false` (Q10).
- **Question ouverte de l'agent** : l'arrêt ferme sa question. `pause.closedQuestion` garde le résumé pour À faire.
- **Agent déjà en erreur de limite** : un agent du compte en `error` `rate-limit` passe en `paused` ; son `scheduledResume` est remplacé par celui de la pause. Il n'y a qu'un minuteur par agent dans `AutoResume` : rien ne se double.

## R7 — Qui est arrêté

- **Decision** : `AgentManager.accountAgents(cliId, account)` rend les agents de tous les workspaces dont `Running.usage.source` a ce CLI et ce compte, hors `closed`, `error` crash et `paused`, plus les agents en `error` `rate-limit` du même compte. Le compte se lit au lancement par `usageOf`, comme pour la jauge. `AgentManager` garde en mémoire la source d'un agent après la fin de son processus, jusqu'à sa fermeture : un agent en erreur de limite sans processus reste attribué. Après un redémarrage de PACT, cette mémoire est vide ; un tel agent garde sa reprise de 001, sans doublon.
- **Conséquences** : un CLI sans lecture n'a pas de `usage` ; il n'est jamais touché (FR-011). Un agent Codex a un autre compte (US1 sc.8). Les terminaux libres ne sont pas des agents. Les fenêtres par modèle arrêtent tout le compte (Q4).

## R8 — La reprise

- **Decision** : à l'arrêt, si `autoResume` est vrai pour le workspace, chaque agent reçoit un `scheduledResume` : `nextResume(agentId, resumeAt, attempt, now)`, avec `resumeAt` égal au plus tardif des `resetsAt` des fenêtres en cause. `AutoResume` arme le minuteur ; `restore` le réarme après un redémarrage.
- **`resumeDue`** accepte `paused`, puis délègue à `UsageLimitService.resumeAccount(cliId, account)`. Celui-ci relit la dernière lecture par `limitBands`. Si une fenêtre est encore en `stop`, avec un reset futur, il replanifie à ce reset : une deuxième fenêtre au-dessus du seuil fait attendre (US2 sc.2). Sinon, il reprend tous les agents en pause du compte, les orchestrateurs d'abord, chacun par `startAgain(workspace, agent, agent.sessionId)` (`--resume`). Les minuteurs des autres agents, devenus sans objet, ne font rien.
- **Heure inconnue** : `resumeAt` absent donne l'attente croissante existante (`BACKOFF_MINUTES`). À l'échéance, PACT reprend ; la règle ne réarrête qu'une lecture plus récente que la reprise (`readAt` > `resumedAt`). Sinon, la vieille lecture réarrêterait l'agent aussitôt (point ouvert O2).
- **Après la reprise** (FR-008, FR-012) : un message `usage-resumed` part dans le journal du workspace. Il est de type `action` pour l'orchestrateur et pour chaque agent `midTurn`, donc réveillé par un pointeur une fois prêt (007). Il est de type `info` pour les autres agents, qui ne sont pas relancés. Le texte nomme la fenêtre, le pourcentage, la durée de la pause, et dit qu'aucun tour n'est compté.
- **Session inconnue** : sans `sessionId`, l'agent reste en pause, avec `pause.blocked: 'session'` et l'action « Relancer » (US2 sc.5).
- **Verrou Git** : avant la reprise, `git rev-parse --git-path index.lock` dans le worktree. Un verrou présent est signalé dans le texte de `usage-resumed` et dans À faire, jamais effacé.

## R9 — Redémarrage de PACT

- **Decision** : `markStale` ne touche plus un agent `paused` ; `restore` appelle `resumes.sync` sur lui, ce qui réarme `scheduledResume`. Une échéance passée pendant l'arrêt de PACT tombe aussitôt et passe par `resumeAccount`. Les dérogations, les consignes et les refus de proposition sont dans `state.json`.

## R10 — « Reprendre », « Annuler », seuil changé

- **« Reprendre »** (US2 sc.8) : sur la tuile, `resume(id)` reprend cet agent seul et écrit une dérogation `usageLimit.overrides` avec son `agentId`. Dans À faire, `usage:resume(cliId, account)` reprend tout le compte comme au reset et écrit une dérogation de compte (`agentId: null`). Chaque dérogation est valable jusqu'au plus tardif des `resetsAt` en cause. Sans heure connue, elle vaut jusqu'à la prochaine lecture qui montre un reset passé. Pendant une dérogation, ni consigne ni arrêt pour ce qu'elle couvre : le compte, ou l'agent seul.
- **« Annuler la reprise »** : `scheduledResume` à `null`, les agents restent en pause, comme `cancelAutoResume`.
- **Reprise auto coupée** : aucun `scheduledResume`. La pause garde le bouton « Reprendre ».
- **Seuil changé** (US4) : `setStops` réévalue chaque compte aussitôt. Un seuil baissé sous la consommation se traite comme un saut de bande : consigne puis arrêt en 60 s au plus. Un seuil relevé au-dessus de toutes les fenêtres d'un compte en pause donne `resumeAccount`.

## R11 — La lecture trop ancienne

- **Decision** : `staleProposal(state, stops, working, now)` pure. Elle est vraie si la lecture a plus de 15 minutes (`STALE_MINUTES`), si au moins un agent du compte est `working`, et si une fenêtre, lue par `currentWindow`, est à 10 points du seuil ou moins. Le service vérifie chaque minute, seulement s'il existe une lecture.
- **Paliers** : le palier est `floor(âge / 15)`. Un refus garde son palier dans `usageLimit.declined` ; la proposition revient au palier suivant (US3 sc.2). Une lecture fraîche efface le refus.
- **Accord** : comme au seuil après un saut de bande. La consigne part, puis l'arrêt en 60 s au plus. `pause.windows` nomme les fenêtres proches du seuil, avec `cause: 'stale'`. La reprise suit R8.
- **Jamais seul** : aucune minuterie n'arrête sur une lecture ancienne (SC-006).

## R12 — `launch_agent` et le lanceur

- **Decision** : pendant une pause d'un compte du CLI, sans dérogation, `launch_agent` rend un `Refusal` (contrats). Le lanceur de l'utilisateur garde son avertissement (005 FR-012), complété par `pauseWarning`. Il ne bloque pas. Le changement amende 005 FR-012, comme la spec le dit.
- **Agent lancé par l'utilisateur pendant la pause** : voir le point ouvert O1.

## R13 — La coupure des réveils (007 FR-016)

- **Decision** : `WakeOptions.usageCritical` devient `usageHeld(cliId)`. Il est vrai si un compte de ce CLI est en pause, ou a une fenêtre en `stop` sans dérogation. Le niveau `critical` de 005 ne coupe plus rien et reste une alerte. `UsageService.critical` disparaît s'il n'a plus d'appelant.
- **Rationale** : 007 FR-016 le prévoit : « niveau `critical` de 005 tant que 009 n'est pas livrée, puis seuil d'arrêt de 009 ».

## R14 — Le journal

- **Decision** : trois kinds dans `EXCHANGE_KINDS` : `usage-save` (`action`), `usage-paused` (`info`, à l'agent arrêté, qu'il lira à sa reprise), `usage-resumed` (type choisi par l'émetteur, comme `message`). Chaque texte contient la fenêtre et le pourcentage (FR-013). Le journal visible de 007 (`ActionsJournal`) les montre sans code nouveau.
- **Workspace sans orchestrateur** : les messages vont aux agents eux-mêmes ; rien ne dépend d'un orchestrateur.

## R15 — Interface

- **Tuile** : `agentStateLabel` rend « en pause · reprise à 16:40 », « en pause · semaine », « en pause · session inconnue ». Le badge « non sauvegardé » suit `pause.saved === false`. Couleurs d'état existantes, aucune nouvelle couleur.
- **À faire** : `usage-paused`, un élément par compte et par workspace, avec « Reprendre » et « Annuler la reprise ». Il nomme les questions fermées et un verrou Git. `usage-stale` porte « Arrêter par prudence » et « Pas maintenant ». Les deux se placent dans `ORDER` après `loop-escalated` et avant `rate-limit`.
- **Réglages** : une section « Arrêt » dans `UsageThresholds.tsx`, un champ par CLI et par fenêtre. Deux avertissements : à 100 %, le seuil ne protège pas d'une erreur de limite ; sous le seuil `critical` de 005 (95 %), le niveau critique n'est plus atteint par les agents de PACT (point ouvert O3).

## R16 — Faux CLI et tests

- **Decision** : `fake-cli.mjs` gagne `onPointer: 'commit'`. À la lecture d'un pointeur, il appelle `get_events`. S'il y trouve `usage-save`, il fait `git add -A && git commit -m "pact: sauvegarde"` dans son dossier, sans push, et imprime `Sauvegardé`. Les lectures viennent du champ `usage` existant (tableau de paliers, 005 R9). Les tests d'intégration créent un remote nu et comparent `git ls-remote` avant et après (SC-007).
- **Horloge** : `Clock` de `auto-resume.ts`, déjà injectable dans `AgentManager`, et passée à `UsageLimitService`.

## R17 — Durées des critères de succès

- **Decision** : 5 s pour l'arrêt, 60 s après un saut de bande, 1 min pour la reprise. Le service agit dans le même tour de boucle que la lecture ; la reprise dépend du minuteur d'`AutoResume`. La spec les donne comme propositions à confirmer : voir O6.

## R18 — Dépendance à 008

- **Decision** : `commitFrozen(agentId)` est injecté et rend `false` tant que 008 n'existe pas. 008 le branchera sur sa demande de livraison. Les tests de US1 sc.9 passent par un faux prédicat.

## Points ouverts

Points laissés à la relecture de l'utilisateur. Le plan suit chaque recommandation, ce qui ne bloque aucune tâche.

| # | Point | Recommandation |
|---|---|---|
| O1 | Un agent lancé par l'utilisateur pendant une pause : sa première lecture dépasse le seuil, et il serait arrêté sans consigne. | Le lancement de l'utilisateur pendant la pause vaut dérogation pour ce seul agent, jusqu'au reset. L'avertissement du lanceur le dit. |
| O2 | Reprise sans heure de reset : la dernière lecture reste au-dessus du seuil. | Reprendre à l'attente croissante, puis n'arrêter de nouveau que sur une lecture plus récente que la reprise. |
| O3 | Q6 dit que le niveau `critical` « ne sera plus vu ». Cela vaut dès que le seuil d'arrêt est sous 95 %, pas seulement à 100 %. | Signaler les deux cas : « à 100 %, aucune protection » ; « sous le seuil critique, la jauge n'atteindra plus le rouge pour les agents de PACT ». |
| O4 | US2 sc.3 et FR-008 : un agent inactif « n'est pas relancé ». | Son processus repart avec `--resume`, à l'invite, sans pointeur ni consigne. Il ne consomme rien. |
| O5 | Saut de bande : « arrêt après 60 s au plus ». | Arrêter chaque agent dès la fin de son tour après la consigne, et au plus tard à 60 s. |
| O6 | Durées des critères de succès (5 s, 60 s, 1 min) proposées par l'agent spec. | Les garder : elles tiennent dans les tests à horloge pilotée. |
