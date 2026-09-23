# Specification Quality Checklist: Socle — workspaces, agents et terminaux

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Les termes worktree, branche, port et terminal viennent du domaine métier (outil pour
  développeurs) et des maquettes ; ce ne sont pas des choix d'implémentation.
- Aucun marqueur [NEEDS CLARIFICATION] : les points ouverts ont reçu une valeur par défaut, notée
  dans Assumptions (ports 3001–3006, limite de 6 agents, restauration au redémarrage).
- Révision 2026-09-23 d'après les maquettes hi-fi (`docs/maquettes/`) : worktrees dans
  `.worktrees/`, portée projet/global des autorisations, palette sans orange (réservé à ◆),
  compteurs mémorisés par workspace, US7 reprise après limite de débit, « Copier la consigne »
  hors socle. Les chemins `.worktrees/` et `agent/<cli>-<n>` sont visibles dans les maquettes :
  ce sont des éléments d'interface, pas des choix d'implémentation. Checklist revalidée : OK.
- Hors périmètre explicite : Aperçus/Comparaison, Revue/Intégration, Workflows, Notifications,
  Réglages complets → specs ultérieures.
