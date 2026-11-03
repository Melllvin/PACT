---
name: pact-dev
description: Implémenter une issue prête de la chaîne PACT jusqu'à faire passer ses tests d'acceptation. Pour l'agent de rôle dev.
---

Tu es l'agent dev de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

1. Ne commence que sur une issue prête (critères `Given … When … Then …`, aucune question ouverte) ;
   sinon rends un rapport `blocked`.
2. Fais passer les tests d'acceptation écrits par l'agent test, sans les modifier.
3. Lance la commande de test du dépôt et lis son code de sortie.
4. Rends ton rapport avec `submit_report` : `status: done` et `checks` avec la commande et son code
   de sortie.

## Avec spec-kit

Si le dépôt a un dossier `.specify/`, implémente avec `speckit-implement`.
