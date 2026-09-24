import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PermissionLevel } from '../../../shared/model';
import { toSpawnCommand } from '../../env/resolve-command';
import { bridgeCommand, detectCommand, nextClockTime, tryRun } from './shared';
import {
  pactEnv,
  supportedLevel,
  type AgentSignal,
  type CliAdapter,
  type CommandRunner,
  type DetectionResult,
  type HookBridge,
  type LaunchInput,
  type LaunchSpec,
  type OutputContext,
  type ResolvedEnv,
} from './types';

// research.md R4–R6, « Caractérisation T049 » (Claude Code 2.1.281).

const MINIMUM_VERSION = '2.1.0';

/** « Actions sensibles » : network, deletion and pushes always ask (R5). */
const SENSITIVE_RULES = [
  'Bash(rm *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(git push *)',
  'WebFetch',
];

/** A permission dialog waits for the user; ten minutes before Claude Code gives up the hook. */
const PERMISSION_HOOK_TIMEOUT_S = 600;

const hookPayloadSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.looseObject({ command: z.string().optional() }).optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  error: z.unknown().optional(),
  error_details: z.string().optional(),
});
type HookPayload = z.infer<typeof hookPayloadSchema>;

type Options = {
  platform: NodeJS.Platform;
  bridge: HookBridge;
  run: CommandRunner;
  now?: () => Date;
};

export class ClaudeCodeAdapter implements CliAdapter {
  readonly id = 'claude-code';
  private readonly platform: NodeJS.Platform;
  private readonly bridge: HookBridge;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  /** Older builds have no `--permission-mode auto`; « Toujours autoriser » then uses acceptEdits. */
  private autoMode = true;

  constructor({ platform, bridge, run, now = () => new Date() }: Options) {
    this.platform = platform;
    this.bridge = bridge;
    this.run = run;
    this.now = now;
  }

  async detect(env: ResolvedEnv): Promise<DetectionResult> {
    const result = await detectCommand('claude', MINIMUM_VERSION, {
      env,
      platform: this.platform,
      run: this.run,
    });
    if (result.resolvedPath) {
      const help = await tryRun(this.run, result.resolvedPath, ['--help'], env);
      this.autoMode = help === null || /"auto"/.test(help);
    }
    return result;
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    return this.spec(input, ['--session-id', input.sessionId ?? randomUUID()]);
  }

  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec {
    return this.spec(input, ['--resume', input.sessionId]);
  }

  mapHookEvent(payload: unknown): AgentSignal | null {
    const parsed = hookPayloadSchema.safeParse(payload);
    return parsed.success ? mapEvent(parsed.data) : null;
  }

  mapOutput(chunk: string, _ctx: OutputContext): AgentSignal | null {
    // The folder trust question comes before any hook (T049).
    if (/Yes, I trust this folder/.test(chunk)) {
      return { type: 'awaiting-answer', summary: 'Faire confiance au dossier ?' };
    }
    return null;
  }

  /** The PermissionRequest hook reply: Claude Code then shows no dialog (R4, FR-034). */
  permissionDecision(behavior: 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } };
  }

  /** `1` picks « Yes »; Escape refuses whatever the options (T049). */
  answerKeys(answer: 'allow' | 'deny'): string {
    return answer === 'allow' ? '1' : '\u001b';
  }

  parseRateLimitReset(text: string): Date | null {
    return nextClockTime(text, /resets(?: at)?/, this.now());
  }

  private spec(input: LaunchInput, sessionArgs: string[]): LaunchSpec {
    const level = supportedLevel(input.permissionLevel);
    const args = [
      ...sessionArgs,
      '--permission-mode',
      this.permissionMode(level),
      '--settings',
      JSON.stringify(this.settings(input, level)),
      ...(input.model ? ['--model', input.model] : []),
    ];
    return {
      ...toSpawnCommand(input.executablePath, args, this.platform, process.env),
      cwd: input.cwd,
      env: pactEnv(input),
    };
  }

  private permissionMode(level: PermissionLevel) {
    if (level === 'always-allow') return this.autoMode ? 'auto' : 'acceptEdits';
    return level === 'ask-sensitive' ? 'acceptEdits' : 'manual';
  }

  private settings(input: LaunchInput, level: PermissionLevel) {
    const http = {
      type: 'http',
      url: input.hook.url,
      headers: { 'X-Pact-Token': '$PACT_AGENT_TOKEN' },
      allowedEnvVars: ['PACT_AGENT_TOKEN'],
    };
    const hook = (handler: object) => [{ hooks: [handler] }];
    return {
      hooks: {
        // Claude Code refuses HTTP hooks for SessionStart (T049).
        SessionStart: hook({ type: 'command', command: bridgeCommand(this.bridge) }),
        UserPromptSubmit: hook(http),
        Notification: hook(http),
        Stop: hook(http),
        StopFailure: hook(http),
        PermissionRequest: hook({ ...http, timeout: PERMISSION_HOOK_TIMEOUT_S }),
      },
      ...(level === 'ask-sensitive' ? { permissions: { ask: SENSITIVE_RULES } } : {}),
    };
  }
}

function mapEvent(event: HookPayload): AgentSignal | null {
  switch (event.hook_event_name) {
    case 'SessionStart':
      return event.session_id === undefined
        ? { type: 'session-started' }
        : { type: 'session-started', sessionId: event.session_id };
    case 'UserPromptSubmit':
      return event.prompt === undefined
        ? { type: 'prompt-submitted' }
        : { type: 'prompt-submitted', prompt: event.prompt };
    case 'PermissionRequest': {
      const tool = event.tool_name ?? 'Outil';
      const command = event.tool_input?.command;
      return command === undefined
        ? { type: 'awaiting-answer', summary: tool, ruleKey: tool }
        : { type: 'awaiting-answer', summary: command, ruleKey: `${tool}(${command})` };
    }
    case 'Notification':
      return event.notification_type === 'permission_prompt' ||
        event.notification_type === 'agent_needs_input'
        ? { type: 'awaiting-answer', summary: event.message ?? 'Claude attend une réponse' }
        : null;
    case 'Stop':
      return { type: 'turn-finished' };
    case 'StopFailure': {
      const error =
        typeof event.error === 'string'
          ? event.error
          : event.error === undefined
            ? 'Erreur inconnue'
            : JSON.stringify(event.error);
      return {
        type: 'failed',
        kind: /rate.?limit/i.test(error) ? 'rate-limit' : 'crash',
        message: event.error_details ?? error,
      };
    }
    default:
      return null;
  }
}
