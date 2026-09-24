# Contrat — Adaptateur de CLI d'agent

Fichier : `src/main/agents/adapters/types.ts`. Un adaptateur par famille de CLI : `claude-code`,
`codex`, `generic` (« Autre CLI »), `fake` (tests uniquement). Ajouter un CLI = écrire un
adaptateur qui passe la suite de tests de contrat commune : la fonction
`runCliAdapterContract(adapterFactory)` de `tests/contract/cli-adapter.contract.ts`, appliquée par un
fichier `tests/contract/<adaptateur>.contract.test.ts` par adaptateur.

```ts
export interface CliAdapter {
  readonly id: 'claude-code' | 'codex' | 'generic' | 'fake';

  /** Détection : noms d'exécutables à chercher et version minimale supportée. */
  detect(env: ResolvedEnv): Promise<DetectionResult>;
  // DetectionResult = { resolvedPath: string | null; version: string | null;
  //                     status: 'installed' | 'missing' | 'unsupported-version' }

  /** Modèles proposés dans le mode détaillé (peut être vide). */
  listModels(): Promise<string[]>;

  /** Construit le lancement d'une nouvelle session. */
  buildLaunch(input: LaunchInput): LaunchSpec;
  /** Construit la reprise d'une session existante (« Reprendre »). */
  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec;
  // LaunchInput = { agentId: string; executablePath: string; cwd: string;
  //                 model: string | null; permissionLevel; sessionId?: string; port: number;
  //                 hook: { url: string; token: string } }
  //  - executablePath : chemin complet résolu à la détection (CliDefinition.resolvedPath)
  // LaunchSpec  = { file: string; args: string[]; env: Record<string, string>; cwd: string }
  //  - env contient toujours PORT, PACT_PORT, PACT_HOOK_URL, PACT_AGENT_TOKEN, PACT_AGENT_ID
  //    (PACT_AGENT_ID = input.agentId)
  //  - cwd = input.cwd (worktree de l'agent, obligation 1)

  /** Traduit un événement de hook reçu (corps JSON) en signal d'état normalisé. */
  mapHookEvent(payload: unknown): AgentSignal | null;

  /** Repli : analyse un morceau de sortie terminal (sans séquences ANSI). */
  mapOutput(chunk: string, ctx: OutputContext): AgentSignal | null;

  /** Séquences de touches à écrire dans le PTY pour répondre à une demande. */
  answerKeys(answer: 'allow' | 'deny'): string;

  /** Extrait l'heure de levée d'un message de limite de débit, si présente. */
  parseRateLimitReset(text: string): Date | null;
}

export type AgentSignal =
  | { type: 'session-started'; sessionId?: string }
  | { type: 'prompt-submitted'; prompt?: string }
  | { type: 'awaiting-answer'; summary: string; ruleKey?: string }
  | { type: 'turn-finished' }
  | { type: 'failed'; kind: 'crash' | 'rate-limit'; message: string; resetAt?: Date };
```

## Obligations testées (suite de contrat commune)

1. `buildLaunch` place toujours le CLI dans `cwd` = worktree de l'agent et fournit les variables
   d'environnement listées.
2. Chaque `permissionLevel` produit des arguments distincts et documentés (research.md R5) ; un
   niveau non supporté retombe sur le plus prudent.
3. `buildResume` réutilise `sessionId` et le même niveau de permissions.
4. `mapHookEvent` ignore les charges invalides (retourne `null`, ne lève pas d'exception).
5. `answerKeys('allow')` / `answerKeys('deny')` débloquent le scénario « autorisation » du faux CLI.
6. Sous Windows, un exécutable `.cmd` est lancé via `cmd.exe /d /s /c` avec arguments échappés
   (research.md R3).

## Adaptateurs

| Adaptateur | Signaux principaux | Repli |
|------------|--------------------|-------|
| claude-code | hooks HTTP injectés via `--settings` : SessionStart, UserPromptSubmit, Notification (`permission_prompt`, `idle_prompt`, `agent_needs_input`), Stop, StopFailure, PermissionRequest (« Toujours pour ce worktree ») | code de sortie, motifs texte |
| codex | hooks (`-c features.hooks=true` + commandes de hook vers le bridge) et `notify` | code de sortie, motifs texte |
| generic | aucun | code de sortie, inactivité > 3 s après sortie terminée par `?` ou `(y/n)` = attend une réponse |
| fake | hooks HTTP du scénario | — |
