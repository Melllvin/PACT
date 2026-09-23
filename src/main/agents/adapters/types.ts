export type ResolvedEnv = Record<string, string | undefined>;
export type DetectionResult = {
  resolvedPath: string | null;
  version: string | null;
  status: 'installed' | 'missing' | 'unsupported-version';
};
export type LaunchInput = {
  cwd: string;
  model: string | null;
  permissionLevel: 'always-allow' | 'ask-sensitive' | 'always-ask';
  sessionId?: string;
  port: number;
  agentId: string;
  hook: { url: string; token: string };
};
export type LaunchSpec = { file: string; args: string[]; env: Record<string, string>; cwd: string };
export type AgentSignal =
  | { type: 'session-started'; sessionId?: string }
  | { type: 'prompt-submitted'; prompt?: string }
  | { type: 'awaiting-answer'; summary: string; ruleKey?: string }
  | { type: 'turn-finished' }
  | { type: 'failed'; kind: 'crash' | 'rate-limit'; message: string; resetAt?: Date };
export type OutputContext = { exitCode?: number; idleMs?: number };
export interface CliAdapter {
  readonly id: 'claude-code' | 'codex' | 'generic' | 'fake';
  detect(env: ResolvedEnv): Promise<DetectionResult>;
  listModels(): Promise<string[]>;
  buildLaunch(input: LaunchInput): LaunchSpec;
  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec;
  mapHookEvent(payload: unknown): AgentSignal | null;
  mapOutput(chunk: string, ctx: OutputContext): AgentSignal | null;
  answerKeys(answer: 'allow' | 'deny'): string;
  parseRateLimitReset(text: string): Date | null;
}
export const launchEnv = (input: LaunchInput) => ({
  PORT: String(input.port),
  PACT_PORT: String(input.port),
  PACT_HOOK_URL: input.hook.url,
  PACT_AGENT_TOKEN: input.hook.token,
  PACT_AGENT_ID: input.agentId,
});
