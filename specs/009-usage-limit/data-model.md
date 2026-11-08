# Data Model: Arrêt à une limite de consommation

Schémas Zod dans `src/shared/usage-limit.ts`, sauf mention contraire. Tous les champs ajoutés aux fichiers existants ont un défaut : un `state.json` ou un fichier de workspace antérieur se lit sans migration.

## Constantes

| Nom | Valeur | Source |
|---|---|---|
| `DEFAULT_STOP` | 90 | FR-001 |
| `MIN_STOP`, `MAX_STOP` | 10, 100 | Q6 |
| `SAVE_BAND` | 3 | FR-003 |
| `JUMP_STOP_MS` | 60 000 | FR-005, Q8 |
| `STALE_MINUTES` | 15 (réutilisé de `usage.ts`) | FR-009 |
| `STALE_MARGIN` | 10 | FR-009 |
| `STALE_CHECK_MS` | 60 000 | R11 |

## Seuil de fenêtre — `usageStops` (`state.json`)

```ts
usageStopsSchema = z.record(z.string().min(1),           // cliId
  z.record(z.string().min(1), z.int().min(10).max(100))) // windowId → %
  .default({})
```

- `stopOf(stops, cliId, windowId)` rend la valeur, sinon `DEFAULT_STOP`.
- `windowsOf(cliId, states)` rend les fenêtres à régler : celles des lectures de ce CLI, plus `five-hour` et `week` pour `claude-code`.

## Bande d'une fenêtre — `LimitBand` (calculé, non stocké)

```ts
type LimitBand = { window: UsageWindow & { reset: boolean }; stop: number; band: 'ok' | 'save' | 'stop' };
limitBands(reading: UsageReading, stops, now): LimitBand[]
```

| Pourcentage (après `currentWindow`) | `band` |
|---|---|
| `< stop − 3` | `ok` |
| `≥ stop − 3` et `< stop` | `save` |
| `≥ stop` | `stop` |

## Pause — `Agent.pause` (fichier de workspace)

```ts
usagePauseSchema = z.object({
  cliId: z.string().min(1),
  account: z.string().min(1),
  cause: z.enum(['threshold', 'stale']),
  windows: z.array(z.object({ id: z.string(), label: z.string(), percent: z.number(),
                               resetsAt: isoDate.nullable() })).min(1),
  /** Le plus tardif des resetsAt, null si l'un d'eux est inconnu. */
  resumeAt: isoDate.nullable(),
  pausedAt: isoDate,
  /** L'agent était dans WORKING_STATES à l'arrêt (FR-008). */
  midTurn: z.boolean(),
  /** Aucun changement non commité à l'arrêt (Q9, Q10). */
  saved: z.boolean(),
  /** Résumé de la question fermée par l'arrêt, s'il y en avait une. */
  closedQuestion: z.string().max(200).nullable(),
  /** La reprise attend un geste : session inconnue (US2 sc.5). */
  blocked: z.enum(['session']).nullable(),
})
agentSchema.pause = usagePauseSchema.nullable().default(null)
```

`agentStateSchema` gagne `paused`. `pause` n'est non nul qu'en `paused`.

### Transitions

| De | Événement | Vers | Effets |
|---|---|---|---|
| `starting`, `working`, `awaiting-prompt`, `awaiting-answer`, `done` | arrêt au seuil ou par prudence | `paused` | processus tué par `stop` ; `pause` rempli ; `scheduledResume` si `autoResume` ; message `usage-paused` |
| `error` (`rate-limit`, même compte) | arrêt | `paused` | `lastError` à `null` ; `scheduledResume` remplacé |
| `paused` | reset atteint, toutes fenêtres en cause libres | `starting` | `startAgain(…, sessionId)` ; `pause` à `null` ; message `usage-resumed` |
| `paused` | « Reprendre » (tuile : l'agent ; À faire : le compte) | `starting` | idem, plus une dérogation d'agent ou de compte |
| `paused` | « Annuler la reprise » | `paused` | `scheduledResume` à `null` |
| `paused` | `sessionId` nul à l'échéance | `paused` | `pause.blocked = 'session'`, `scheduledResume` à `null` |
| `paused` | « Relancer » | `starting` | nouvelle session, `pause` à `null` |
| `paused` | « Fermer » | `closed` | comme 006 |
| `paused` | redémarrage de PACT | `paused` | `markStale` l'ignore ; `restore` réarme |
| `paused` | tout signal de CLI | `paused` | `applySignal` rend l'agent inchangé |

## Consigne de sauvegarde — `usageLimit.saves` (`state.json`)

```ts
usageSaveSchema = z.object({
  cliId: z.string(), account: z.string(), windowId: z.string(),
  /** Le reset visé ; null si inconnu : la consigne vaut jusqu'à une lecture qui montre un reset. */
  resetsAt: isoDate.nullable(),
  at: isoDate,
  agentIds: z.array(z.uuid()),
})
```

Une consigne existe par `(cliId, account, windowId)` ; elle est remplacée quand son `resetsAt` est passé.

## Dérogation — `usageLimit.overrides` (`state.json`)

```ts
usageOverrideSchema = z.object({
  cliId: z.string(), account: z.string(),
  /** null : jusqu'à une lecture qui montre un reset passé. */
  until: isoDate.nullable(),
  /** null : tout le compte (« Reprendre » d'À faire) ; sinon un agent (« Reprendre » de sa tuile, ou lancé par l'utilisateur en pause, O1). */
  agentId: z.uuid().nullable(),
})
```

## Proposition d'arrêt par prudence — `usageLimit.declined` (`state.json`)

```ts
usageDeclinedSchema = z.object({ cliId: z.string(), account: z.string(),
                                 readAt: isoDate, step: z.int().min(1) })
```

- `staleProposal(state, stops, workingCount, now)` rend `{ step, windows } | null`.
- La proposition s'affiche si `step` est plus grand que le palier refusé pour cette même lecture (`readAt`).

## Ensemble `usageLimit` (`state.json`)

```ts
usageLimitStateSchema = z.object({
  saves: z.array(usageSaveSchema).default([]),
  overrides: z.array(usageOverrideSchema).default([]),
  declined: z.array(usageDeclinedSchema).default([]),
  /** Dernière reprise par compte, pour la règle O2. */
  resumed: z.array(z.object({ cliId: z.string(), account: z.string(), at: isoDate })).default([]),
}).default({ saves: [], overrides: [], declined: [], resumed: [] })
```

## Journal (extension de 007, `src/shared/exchanges.ts`)

| Kind | Type | De → à | Quand |
|---|---|---|---|
| `usage-save` | `action` | `pact` → agent | entrée en bande `save`, saut de bande, accord par prudence |
| `usage-paused` | `info` | `pact` → agent arrêté | arrêt |
| `usage-resumed` | `action` pour l'orchestrateur et les agents `midTurn`, `info` sinon | `pact` → agent | reprise |

`typeOf('usage-resumed', chosen)` suit la règle de `message` : le type est choisi par l'émetteur. Le texte fait au plus 2 000 caractères (`MAX_NOTICE`).

## À faire (`src/shared/model.ts`, `src/shared/todo.ts`)

`TodoKind` gagne `usage-paused` et `usage-stale`. Ils se placent dans `ORDER` après `loop-escalated` et avant `rate-limit`.

```ts
TodoItem.usageLimit?: { cliId: string; account: string; kind: 'paused' | 'stale'; step?: number }
```

## Relations

- Un compte (`cliId`, `account`) a 0 à N fenêtres, chacune avec un seuil (`usageStops`).
- Une pause appartient à un agent et nomme son compte : elle survit à la disparition du processus, donc de `Running`.
- Une consigne vise un compte, une fenêtre et un reset, et liste les agents touchés.
