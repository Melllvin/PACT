# Contract: fichiers de la chaîne dans les worktrees

## `.pact/issues/<id>.md` (worktree de l'orchestrateur ou de l'agent spec)

```markdown
# <Titre>

## Contexte
<texte>

## Critères d'acceptation
- Given <…> When <…> Then <…>

## Fichiers probables
- <chemin>

## Hors périmètre
- <…>

## Questions ouvertes
- <question>   (rubrique absente ou vide ⇒ aucune question)
```

« Prête » (FR-022) : au moins une ligne `Given … When … Then …` sous « Critères d'acceptation » et
aucune entrée sous « Questions ouvertes ». `id` = nom du fichier sans `.md`.

## `.pact/recap.md` (worktree de l'orchestrateur)

```markdown
# Recap — <date>

## <id> · <titre> — <état>
- Agents : <nom> (dev, <modèle>), <nom> (test, <modèle>)
- Branche : <branche> · PR : <lien ou « aucune »>
- Tours : <n>/3 · Tests PACT : <commande> → <code>
### À tester à la main
- <vérification>   (ou « Rien à tester à la main »)
```

## `design/` (worktree de l'agent design)

- `design/tokens.json` (W3C Design Tokens), `design/tokens.css` (variables CSS dérivées),
  `design/DESIGN.md` (guide).
- `design/mockups/*.html` : maquettes statiques, liées à `../tokens.css` seulement.

L'Aperçu (FR-025) liste `design/mockups/*.html` (`mockup`), `.pact/recap.md` (`recap`),
`.pact/issues/*.md` (`issue`).
