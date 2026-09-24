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

// research.md R4–R6, « Caractérisation T049 » (Codex 0.156.1).

const PERMISSIONS: Record<PermissionLevel, { approval: string; sandbox: string }> = {
  'always-allow': { approval: 'never', sandbox: 'workspace-write' },
  'ask-sensitive': { approval: 'on-request', sandbox: 'workspace-write' },
  'always-ask': { approval: 'on-request', sandbox: 'read-only' },
};

/** Hooks PACT listens to; Codex runs them once the user has trusted them in its review screen. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'] as const;

/** Codex also reports the turn of an internal thread that names the session (T049). */
const TITLE_THREAD_PROMPT = /^Generate a concise, single-line task title/;

const hookPayloadSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.looseObject({ command: z.string().optional() }).optional(),
});

const notifyPayloadSchema = z.looseObject({
  type: z.literal('agent-turn-complete'),
  'thread-id': z.string(),
  'input-messages': z.array(z.string()).optional(),
});

/** TOML basic strings share JSON's escapes for the characters paths and commands contain. */
const toml = (value: string) => JSON.stringify(value);

type Options = {
  platform: NodeJS.Platform;
  bridge: HookBridge;
  run: CommandRunner;
  now?: () => Date;
};

export class CodexAdapter implements CliAdapter {
  readonly id = 'codex';
  private readonly platform: NodeJS.Platform;
  private readonly bridge: HookBridge;
  private readonly run: CommandRunner;
  private readonly now: () => Date;

  constructor({ platform, bridge, run, now = () => new Date() }: Options) {
    this.platform = platform;
    this.bridge = bridge;
    this.run = run;
    this.now = now;
  }

  /** Without the `hooks` feature PACT cannot follow the agent: `unsupported-version` (R4). */
  async detect(env: ResolvedEnv): Promise<DetectionResult> {
    const result = await detectCommand('codex', '0.0.0', {
      env,
      platform: this.platform,
      run: this.run,
    });
    if (!result.resolvedPath) return result;
    const features = await tryRun(this.run, result.resolvedPath, ['features', 'list'], env);
    const hooks = features !== null && /^hooks\s+\S+(?:\s\S+)*\s+true\s*$/m.test(features);
    return hooks ? result : { ...result, status: 'unsupported-version' };
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    return this.spec(input, []);
  }

  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec {
    return this.spec(input, ['resume', input.sessionId]);
  }

  mapHookEvent(payload: unknown): AgentSignal | null {
    const notify = notifyPayloadSchema.safeParse(payload);
    if (notify.success) {
      const [first] = notify.data['input-messages'] ?? [];
      if (first !== undefined && TITLE_THREAD_PROMPT.test(first)) return null;
      return { type: 'turn-finished', sessionId: notify.data['thread-id'] };
    }
    const hook = hookPayloadSchema.safeParse(payload);
    if (!hook.success) return null;
    const event = hook.data;
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
      case 'Stop':
        return event.session_id === undefined
          ? { type: 'turn-finished' }
          : { type: 'turn-finished', sessionId: event.session_id };
      default:
        return null;
    }
  }

  mapOutput(chunk: string, _ctx: OutputContext): AgentSignal | null {
    // Both screens come before any hook; PACT leaves the answer to the user (T049).
    if (/Trust this folder\?/.test(chunk)) {
      return { type: 'awaiting-answer', summary: 'Faire confiance au dossier ?' };
    }
    if (/Hooks need review/.test(chunk)) {
      return { type: 'awaiting-answer', summary: 'Approuver les hooks PACT ?' };
    }
    // The banner only: an agent may well write « rate limit » while working on retries.
    if (/You've hit your usage limit/i.test(chunk)) {
      const resetAt = this.parseRateLimitReset(chunk);
      return {
        type: 'failed',
        kind: 'rate-limit',
        message: chunk.trim(),
        ...(resetAt ? { resetAt } : {}),
      };
    }
    return null;
  }

  /** `y` is the shortcut of « Yes, proceed »; Escape is « No » (T049). */
  answerKeys(answer: 'allow' | 'deny'): string {
    return answer === 'allow' ? 'y' : '\u001b';
  }

  parseRateLimitReset(text: string): Date | null {
    return nextClockTime(text, /try again at/, this.now());
  }

  private spec(input: LaunchInput, sessionArgs: string[]): LaunchSpec {
    const { approval, sandbox } = PERMISSIONS[supportedLevel(input.permissionLevel)];
    const config = (value: string) => ['-c', value];
    const hookCommand = toml(bridgeCommand(this.bridge));
    const notify = ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', ...this.bridgeArgs('--notify')];
    const args = [
      ...sessionArgs,
      ...config('check_for_update_on_startup=false'),
      '-a',
      approval,
      '-s',
      sandbox,
      // A worktree keeps its Git metadata in <repo>/.git/worktrees: without it, no commit (T049).
      ...config(`sandbox_workspace_write.writable_roots=[${toml(`${input.repoPath}/.git`)}]`),
      ...HOOK_EVENTS.flatMap((event) =>
        config(`hooks.${event}=[{hooks=[{type="command",command=${hookCommand}}]}]`),
      ),
      // No /usr/bin/env on Windows, where notify was not characterized: heuristic only there.
      ...(this.platform === 'win32' ? [] : config(`notify=[${notify.map(toml).join(',')}]`)),
      ...(input.model ? ['-m', input.model] : []),
    ];
    return {
      ...toSpawnCommand(input.executablePath, args, this.platform, process.env),
      cwd: input.cwd,
      env: pactEnv(input),
    };
  }

  private bridgeArgs(...args: string[]) {
    return [this.bridge.executable, this.bridge.script, ...args];
  }
}
