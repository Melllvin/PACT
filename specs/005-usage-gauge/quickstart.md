# Quickstart : valider la jauge d'usage

## Automatique

```sh
npm run check                 # schémas, analyse des sources, UsageService, route /statusline
npm run test:e2e -- us24 us25 us26 us27
```

Les e2e utilisent le faux CLI : étape `usage` (Claude) et `rollout` (Codex), voir research.md R9.

## Manuel, sur vrais CLI (caractérisation, SC-002)

1. Ouvrir un workspace, lancer un agent Claude Code connecté par abonnement, lui envoyer une consigne.
2. Après la première réponse : la barre montre « Claude Code N % · 5 h » ; comparer avec `/usage`
   dans le terminal de l'agent (écart ≤ 2 points).
3. Même chose avec Codex et `/status`.
4. Avec une `statusLine` personnelle dans `~/.claude/settings.json` : elle reste affichée en bas du
   terminal de l'agent, et `~/.claude/settings.json` est inchangé (`git diff --no-index` d'une copie).
5. Avec `ANTHROPIC_API_KEY` : aucune jauge Claude Code, aucune erreur.
6. Régler les seuils à 10 / 20 % : la jauge devient orange puis rouge, À faire montre une seule alerte.
