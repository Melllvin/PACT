# Revue de sécurité (T114)

Revue du 2026-09-25 sur la branche `001-phase-10-polish`. Chaque point vérifiable est couvert par
un test ; les écarts trouvés ont été corrigés avec un test rouge d'abord.

## Points vérifiés

| Point | État | Test |
|-------|------|------|
| CSP du renderer : `default-src 'self'`, `script-src 'self'` (ni script en ligne ni `eval`) | conforme | `tests/unit/main/security.test.ts` |
| CSP : `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` | **écart corrigé** (directives absentes) | `tests/unit/main/security.test.ts` |
| Fenêtre : `sandbox`, `contextIsolation`, pas de `nodeIntegration`, preload CommonJS | conforme | `tests/unit/main/window.test.ts` |
| Aucune commande shell construite depuis le renderer : `node-pty` et `git` reçoivent leurs arguments en liste, jamais `exec` ni `shell: true` | conforme | `tests/unit/main/security.test.ts` |
| `git clone` d'une URL venue du renderer : `--` avant l'URL (pas d'option injectée) et transport `ext::` refusé même si la config git de l'utilisateur l'autorise | **écart corrigé** (`ext::` exécutait une commande avec `protocol.allow=always`) | `tests/unit/main/security.test.ts` |
| Jeton de hooks jamais journalisé : aucun `console.*` dans `src/main` ni `src/preload` | conforme | `tests/unit/main/security.test.ts` |
| Serveur de hooks lié à `127.0.0.1` seulement, jeton secret par agent, corps limité | conforme | `tests/unit/main/security.test.ts`, `tests/integration/hooks/hook-server.test.ts` |

## Ajouts sans tâche dédiée, justifiés ici

- **Blocage de `window.open` et de la navigation** (`src/main/window.ts`, T128) : recommandations
  de sécurité d'Electron (« limiter la navigation », « limiter la création de fenêtres »). Un lien
  ou une sortie de CLI rendue dans l'interface ne peut ni ouvrir une fenêtre qui hériterait du
  preload, ni remplacer la page de PACT par une page tierce qui recevrait l'API `window.pact`.
  Conservé.
- **Contrôle d'origine IPC `trustedSenderCheck`** (`src/main/app-services.ts`, T130) : Electron
  recommande de valider l'expéditeur de chaque message IPC. Seule la page `index.html` construite
  (ou le serveur de dev) peut appeler les services du processus principal. Conservé.
- **`ELECTRON_RENDERER_URL` ignorée dans une app packagée** (T130) : sans cela, une variable
  d'environnement suffirait à charger une page distante dans la fenêtre de PACT et à lui donner
  l'IPC. Conservé.
- **`app:getState` câblé dès la phase 2** (T130) : c'est le canal de lecture qui hydrate le
  renderer au démarrage (workspaces, récents, CLI, préférence de permissions) ; il ne fait que
  lire l'état déjà enregistré et passe par le même contrôle d'origine. Conservé.

## Limites connues

- `PACT_TEST_MODE=1` (harnais e2e) redirige `userData` et saute la question de fermeture ; seul
  quelqu'un qui lance PACT lui-même avec cette variable peut l'activer.
