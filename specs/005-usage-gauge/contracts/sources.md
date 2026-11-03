# Contrat : sources lues

## Claude Code — `statusLine` (entrée standard de la commande)

Champs utilisés (les autres sont ignorés ; l'absence de l'un d'eux ne fait jamais échouer) :

```json
{
  "session_id": "…",
  "model": { "id": "claude-…", "display_name": "…" },
  "context_window": { "total_input_tokens": 0, "total_output_tokens": 0 },
  "rate_limits": {
    "five_hour": { "used_percentage": 62, "resets_at": 1793721600 },
    "seven_day": { "used_percentage": 18, "resets_at": 1794067200 }
  }
}
```

- `rate_limits` absent → pas de lecture (part par agent quand même relevée).
- toute autre clé sous `rate_limits` ayant `used_percentage` est une fenêtre de plus (par modèle),
  libellée d'après sa clé.

Réponse de `/statusline` : `200`, texte brut d'une ligne. Jeton inconnu : `401`, corps vide.

Pont : `"<Electron>" hook-bridge.js --statusline`, `ELECTRON_RUN_AS_NODE=1`. Si une `statusLine`
utilisateur de type `command` existe (réglages utilisateur puis projet, lecture seule), le pont
l'exécute avec la même entrée (délai 2 s) et imprime sa sortie à la place de la réponse de PACT ; la
charge est postée à PACT dans tous les cas.

## Codex — `token_count` d'un rollout

Fichier : `$CODEX_HOME/sessions/AAAA/MM/JJ/rollout-*-<sessionId>.jsonl`, une ligne JSON par
événement. Ligne utilisée (la dernière qui contient `rate_limits`) :

```json
{ "type": "event_msg", "payload": { "type": "token_count",
  "info": { "total_token_usage": { "input_tokens": 0, "output_tokens": 0 } },
  "rate_limits": {
    "primary":   { "used_percent": 18, "window_minutes": 300,   "resets_at": 1793721600 },
    "secondary": { "used_percent": 4,  "window_minutes": 10080, "resets_at": 1794067200 }
  } } }
```

- `window_minutes` 300 → « 5 h », 10080 → « semaine », autre → « N h ».
- `rate_limits` nul ou absent → pas de lecture.
- Ligne illisible : ignorée.
