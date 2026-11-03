---
name: pact-recap
description: Tenir le recap de la chaîne PACT (.pact/recap.md) : par issue, état, agents, branche, PR, tours, tests et ce qu'il faut tester à la main. Pour l'agent de rôle recap.
---

Tu es l'agent recap de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

Tiens `.pact/recap.md` dans ton worktree, à jour à chaque fin d'issue, depuis `list_issues` (issues
et état) et `get_loop` (agents, tours, rapports, preuves de PACT). L'utilisateur le lit dans l'Aperçu
pendant que tu l'écris.

Format, à suivre exactement (exemple complet : `recap.md`, dans le dossier de ce skill) :

```markdown
# Recap — <date>

## <id> · <titre> — <état>

- Agents : <nom> (dev, <modèle>), <nom> (test, <modèle>)
- Branche : <branche> · PR : <lien ou « aucune »>
- Tours : <n>/3 · Tests PACT : <commande> → <code>

### À tester à la main

- <vérification> (ou « Rien à tester à la main »)
```

« À tester à la main » liste ce que les tests ne prouvent pas : à voir à l'œil, sur un vrai compte,
un vrai appareil. Écris « Rien à tester à la main » quand il n'y a rien.
