# Contrat : hooks et adapters

Validé sur Claude Code 2.1.318 : `research.md` R1.

## `CliAdapter` (ajout)

```text
readonly midTurnWake: boolean
wakeReply?(payload: unknown, pointer: string): object | null
isWakePoint?(payload: unknown): 'tool' | 'stop' | null
```

`isWakePoint` rend `null` dès que `agent_id` est présent : un sous-agent ou un coéquipier ne reçoit jamais de pointeur.

| Adapter | `midTurnWake` | Points |
|---|---|---|
| Claude Code | vrai | `PostToolUse` → `tool`, `Stop` → `stop` |
| Codex | faux | fin de tour tapée |
| Generic | faux | fin de tour tapée ; fichier d'événements |
| Fake | vrai, sauf `FAKE_CLI_NO_WAKE_HOOK=1` | `post-tool`, `turn-finished` |

## Réponses Claude Code

```json
{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "<pointeur>" } }
```

```json
{ "decision": "block", "reason": "<pointeur>" }
```

`settings` ajoute `PostToolUse: hook(http)`.

## Handler (`AgentManager.start`)

```text
point = adapter.isWakePoint?.(payload)
si point et adapter.midTurnWake :
  pointer = wake.takeForHook(agent.id, point)
  si pointer : rendre adapter.wakeReply(payload, pointer), sans appliquer le signal
continuer comme aujourd'hui (mapHookEvent, alwaysAllowed, apply)
```

`takeForHook` : plafond et consommation vérifiés ; `tool` respecte la fenêtre de 5 s, `stop` la vide ; les messages sont marqués annoncés.

Une réponse de hook n'écrit jamais dans le terminal (Q10).
