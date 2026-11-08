# Data Model: Échanges entre agents et réveil

Schémas Zod dans `src/shared/exchanges.ts`, intégrés à `workspaceSchema`. Les anciens fichiers se chargent sans migration : tous les champs ont un défaut.

## Constantes

| Nom | Valeur | Source |
|---|---|---|
| `MAX_MESSAGE` | 500 caractères | FR-002 (écrit par un agent) |
| `MAX_NOTICE` | 2000 caractères | R8 (construit par PACT, tronqué) |
| `MAX_INSTRUCTION` | 8000 caractères | R11 (`MAX_PROMPT` existant) |
| `MAX_EVENTS` | 20 | FR-009, FR-019 |
| `MAX_EVENT_SUMMARY` | 200 caractères | FR-009, FR-019 |
| `MAX_TURN_MESSAGES` | 5 | FR-005 |
| `MAX_ROUND_TRIPS` | 3 | FR-006 |
| `MAX_JOURNAL` | 500 | FR-004 |
| `WAKE_GROUP_MS` | 5000 | FR-011 |
| `MAX_WAKES_PER_HOUR` | 20 | FR-016 |
| `HELD_INPUT_NOTICE_MS` | 120000 | FR-014 |

## ExchangeMessage (persisté)

| Champ | Type | Règle |
|---|---|---|
| `id` | uuid | |
| `at` | date ISO | |
| `from` | uuid d'agent, ou `'pact'` | |
| `to` | uuid d'agent | destinataire |
| `about` | uuid d'agent, optionnel | agent concerné par un événement de PACT |
| `state` | `AgentState`, optionnel | état au moment de l'événement |
| `type` | `action` \| `info` | `typeOf(kind)`, sauf `message` où l'expéditeur choisit |
| `kind` | liste fermée de R3 | |
| `text` | chaîne | borne selon le `kind` : `message` 500, `instruction` 8000, autres 2000 |
| `integration` | structure existante, optionnelle | reprise de `orchestratorEventSchema` |
| `unreadBy` | uuid[] | destinataire et, pour un message entre agents, orchestrateur |

**Copie** : pas de doublon. L'orchestrateur est dans `unreadBy` du message d'origine, et son réveil ne compte que les messages dont il est `to`.

**Rendu** : `summary` = `text` tronqué à `MAX_EVENT_SUMMARY`. Un agent ne reçoit que des messages où il figure dans `unreadBy` ; le détail par `id` n'est rendu qu'à `from`, `to` ou l'orchestrateur.

## ExchangeEscalation (persisté)

| Champ | Type | Règle |
|---|---|---|
| `id` | uuid | |
| `agents` | `[uuid, uuid]` triés | une escalade ouverte par paire |
| `lastMessageId` | uuid | le dernier échange, affiché |
| `state` | `pending` \| `cut` | `resume` la retire, `cut` la garde |
| `at` | date ISO | |

## Workspace

```text
exchanges: { messages: ExchangeMessage[] (≤ 500), escalations: ExchangeEscalation[] }, défaut vide
```

## Agent

```text
wakeNotice?: 'input' | 'cap' | null   // réveil retenu et signalé ; lu par deriveTodos
```

## TodoKind

| Nouveau `kind` | Titre | Actions | Rang |
|---|---|---|---|
| `exchange-escalated` | `✕ Échanges en boucle · <A> ↔ <B> · 3 allers-retours` | « Laisser reprendre », « Couper » | après `loop-escalated` |
| `wake-held` | `◆ Réveil en attente · <agent>` + raison | `open-terminal` si `input` | après `usage-limit` |

`exchange-escalated` va en tête de colonne ; `wake-held` va sur la ligne de son agent (`ROW_KINDS`). `exchange-escalated` rejoint `NOTIFIED` dans `src/main/notifications.ts`.

## Changement de `decide`

```text
routed = lead existe, lead.state ≠ 'error', agent.id ≠ lead.id
ready + rapport blocked + questions : si routed → pas de 'decide', la suite de agentTodo s'applique
```

`answer` (`◆ Répondre`) passe avant cette règle et ne change pas.

## État en mémoire (non persisté)

| Où | Contenu | Après redémarrage |
|---|---|---|
| `WakeService` | `announced` par agent, fenêtre de regroupement, 20 derniers réveils, `heldSince` | vide : les non-lus repartent |
| `ExchangeService` | compteur par tour, allers-retours par paire et `HEAD` vus | vide : repart de zéro |
| `AgentManager` | `draft` par agent : nombre, `unknown`, `stuck` | vide : invite supposée vide au lancement du CLI |

## Retirés

`EventQueue` (`orchestrator/events.ts`) et `Session.events` ; `LoopService.testerStart`, `markTesterStart`.
