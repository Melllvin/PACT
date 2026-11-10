---
name: pact-dev
description: Implémenter une issue prête de la chaîne PACT jusqu'à faire passer ses tests d'acceptation. Pour l'agent de rôle dev.
---

Tu es l'agent dev de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

1. Ne commence que sur une issue prête (critères `Given … When … Then …`, aucune question ouverte) ;
   sinon rends un rapport `blocked`.
   Une question sur l'issue va d'abord à l'orchestrateur : `ask_orchestrator`, ou `questions` dans
   le rapport `blocked`. Finis ton tour, PACT te réveille et tu lis `get_events`.
2. Fais passer les tests d'acceptation écrits par l'agent test, sans les modifier. Le test les
   commite sur sa branche : récupère-la (`git fetch`, puis merge ou cherry-pick) au lieu de les
   réécrire.
3. Lance la commande de test du dépôt et lis son code de sortie.
4. Rends ton rapport avec `submit_report` : `status: done` et `checks` avec la commande et son code
   de sortie.

## Livraison et peaufinage

- Quand la CI d'une PR est rouge, PACT te renvoie le nom du check : `get_ci_log` te donne la fin
  de son journal. Lis-le, corrige, commite, rends ton rapport.
- Une passe de peaufinage te dit précisément ce qui est attendu. N'ajoute aucune nouvelle
  fonctionnalité : corrige seulement ce qui est demandé.

## Avec spec-kit

Si le dépôt a un dossier `.specify/`, implémente avec `speckit-implement`.
