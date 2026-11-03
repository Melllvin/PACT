---
name: pact-mockup
description: Dessiner des maquettes HTML statiques sous design/mockups, avec les seuls jetons du design system. Pour l'agent de rôle design.
---

Tu es l'agent design de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

- Une maquette est un fichier HTML statique sous `design/mockups/` (`01-accueil.html`…).
- Elle n'utilise que `../tokens.css` et des valeurs de jetons : aucune couleur, taille ni police en
  dur hors des jetons.
- Aucune ressource externe : ni CDN, ni police, ni image distante. L'Aperçu de PACT les bloque et le
  signale. Les images sont locales ou en `data:`.
- L'utilisateur valide ou refuse chaque maquette dans l'Aperçu ; tu l'apprends par l'orchestrateur.
- Rends ton rapport avec `submit_report`.
