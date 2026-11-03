# Contract: suite de skills et livraison par CLI

## Contenu (resources/skills/)

| Skill | Rôle | Doit dire (exigences) |
|-------|------|-----------------------|
| `pact-contract.md` | tous | format du rapport (handoff-report.md), règles de boucle (3 tours, preuve par PACT), Definition of Ready (critères G/W/T, aucune question ouverte), Definition of Done (tests PACT à 0, rapport rendu, recap à jour), pas de fichiers communs en parallèle, questions à l'utilisateur |
| `pact-orchestrator` | orchestrateur | méthode de 003 + chaîne : cadrage → design → boucle → recap ; noms et rôles des autres skills ; `launch_agent` par rôle ; jamais de 4ᵉ tour ; spec-kit si `.specify/` (FR-009, FR-010) |
| `pact-spec` | spec | questions, issues au format de files.md, `register_issue` ; avec `.specify/` : `speckit-specify`, `-clarify`, `-plan`, `-tasks`, `-analyze`, `-taskstoissues` dans cet ordre (FR-010) |
| `pact-design-system` | design | chercher un design system (jetons W3C, `DESIGN.md`) ; sinon le créer depuis l'application (couleurs, typo, espacements, composants) dans `design/tokens.json`, `design/tokens.css`, `design/DESIGN.md` ; demander la validation via une maquette `design/mockups/00-design-system.html` (FR-012) |
| `pact-mockup` | design | maquettes HTML statiques sous `design/mockups/`, seulement `tokens.css` et des valeurs de jetons, aucune ressource externe (FR-012, FR-026) |
| `pact-dev` | dev | ne commence que sur une issue prête ; fait passer les tests d'acceptation ; lance la commande de test ; rapport `done` avec `checks` ; avec `.specify/` : `speckit-implement` (FR-010) |
| `pact-test` | test | écrit d'abord les tests d'acceptation (rouges), ne touche jamais au code de production, juge sur le diff et l'issue, verdict dans le rapport ; avec `.specify/` : `speckit-converge` (FR-011) |
| `pact-recap` | recap | tient `.pact/recap.md` au format de files.md depuis `list_issues` et `get_loop` (FR-029) |

Le rôle `design` reçoit `pact-design-system` et `pact-mockup`. Chaque agent reçoit son ou ses skills et
le contrat, rien d'autre (FR-009).

## Livraison (R3)

| CLI | Voie | Vérifiable |
|-----|------|-----------|
| Claude Code | plugin de session `--plugin-dir userData/roles/<agentId>/plugin` : `skills/<nom>/SKILL.md`, `.mcp.json` (jeton d'agent ou d'orchestrateur) | arguments du contrat d'adaptateur |
| Codex | `-c developer_instructions="Tu es l'agent <rôle> de PACT. Lis et applique <chemin>/SKILL.md et <chemin>/pact-contract.md."` + `-c mcp_servers.pact.url=…` + `-c mcp_servers.pact.env_http_headers={ "X-Pact-Token" = "PACT_AGENT_MCP_TOKEN" }` | arguments du contrat d'adaptateur |
| Générique | `.pact/ROLE.md` (concaténation skill + contrat), `/.pact/ROLE.md` dans `.git/info/exclude`, consigne « Lis .pact/ROLE.md » avant la première consigne | fichier, exclusion, `git status` propre |

Aucune voie n'écrit dans `~/.claude`, `~/.codex` ni dans un fichier suivi du dépôt (FR-014, SC-007).
`userData/roles/<agentId>/` et `.pact/ROLE.md` sont retirés à la fermeture de l'agent.
