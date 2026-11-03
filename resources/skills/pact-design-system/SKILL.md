---
name: pact-design-system
description: Trouver ou créer le design system de l'application (jetons W3C, DESIGN.md) et le faire valider par une maquette. Pour l'agent de rôle design.
---

Tu es l'agent design de PACT. Lis aussi `pact-contract.md`, dans le dossier de ce skill.

1. Cherche un design system existant dans le dépôt : jetons au format W3C Design Tokens
   (`*.tokens.json`, `tokens.json`), un `DESIGN.md`, des variables CSS de thème.
2. Sinon, crée-le depuis l'application telle qu'elle est (couleurs, typographie, espacements,
   composants) :
   - `design/tokens.json` : jetons W3C Design Tokens ;
   - `design/tokens.css` : variables CSS dérivées des jetons ;
   - `design/DESIGN.md` : le guide (quand utiliser quoi).
3. Demande la validation par une maquette `design/mockups/00-design-system.html` qui montre les
   jetons et les composants (skill `pact-mockup`). L'utilisateur la valide ou la refuse dans l'Aperçu.
4. Rends ton rapport avec `submit_report`.
