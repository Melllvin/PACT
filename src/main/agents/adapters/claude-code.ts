import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PermissionLevel } from '../../../shared/model';
import { toSpawnCommand } from '../../env/resolve-command';
import { pluginSkill, SKILL_NAME } from '../../orchestrator/plugin';
import { CONTRACT, type RoleSkills } from '../../orchestrator/role-skills';
import { ROLE_LABELS } from '../../../shared/roles';
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

/** 003 R2 — the tools of the session plugin's MCP server, as Claude Code names them. */
const PACT_TOOLS = 'mcp__plugin_pact_pact__*';

/**
 * 003 R5 — far above the longest wait_for_agents (60 s since 007), so that Claude Code never gives up
 * on a tool call; kept as it was, a looser bound costing nothing.
 */
const MCP_TOOL_TIMEOUT_MS = '660000';

const ORCHESTRATOR_PROMPT = `Tu es l'orchestrateur de ce workspace PACT : tu diriges les autres agents avec le skill ${SKILL_NAME} et les outils du serveur MCP « pact ».`;

/** 004 R3 — an agent with another role is sent to the skills of its role in the plugin. */
const rolePrompt = ({ role, skills }: RoleSkills) =>
  `Tu es l'agent ${ROLE_LABELS[role].toLowerCase()} de PACT : applique ${skills.map((s) => `le skill ${pluginSkill(s.name)}`).join(' et ')}, avec le contrat ${CONTRACT} de son dossier, et rends ton rapport avec l'outil submit_report du serveur MCP « pact ».`;

/** A permission dialog waits for the user; ten minutes before Claude Code gives up the hook. */
const PERMISSION_HOOK_TIMEOUT_S = 600;

const hookPayloadSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  /** Set when the hook fires in a subagent or an in-process teammate, never in the lead. */
  agent_id: z.string().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z
    .looseObject({
      command: z.string().optional(),
      /** AskUserQuestion: the questions Claude asks, each with its options. */
      questions: z.array(z.looseObject({ question: z.string().optional() })).optional(),
    })
    .optional(),
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
  /** `statusLine.refreshInterval` (seconds) of the user's own settings, `null`: none. */
  userStatusLineInterval?: number | null;
};

/** The gauge is refreshed at least this often (seconds), the user's shorter interval winning. */
const STATUSLINE_REFRESH_SECONDS = 300;

export class ClaudeCodeAdapter implements CliAdapter {
  readonly id = 'claude-code';
  /** 005 R1 — the statusLine it runs with its account's limits. */
  readonly usageSource = 'claude-statusline' as const;
  readonly supportsOrchestrator = true;
  private readonly platform: NodeJS.Platform;
  private readonly bridge: HookBridge;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly refreshInterval: number;
  /** Older builds have no `--permission-mode auto`; « Toujours autoriser » then uses acceptEdits. */
  private autoMode = true;

  constructor({
    platform,
    bridge,
    run,
    now = () => new Date(),
    userStatusLineInterval = null,
  }: Options) {
    this.refreshInterval = Math.min(
      STATUSLINE_REFRESH_SECONDS,
      userStatusLineInterval ?? STATUSLINE_REFRESH_SECONDS,
    );
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

  readonly supportsEffort = true;
  /** 007 R1 — validated on Claude Code 2.1.318: PostToolUse and Stop carry a text to the agent. */
  readonly midTurnWake = true;

  listModels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** The aliases `--model` takes, whatever the current version behind each. */
  modelTiers(): string[][] {
    return [['haiku'], ['sonnet'], ['opus']];
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    return this.spec(input, ['--session-id', input.sessionId ?? randomUUID()]);
  }

  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec {
    return this.spec(input, ['--resume', input.sessionId]);
  }

  mapHookEvent(payload: unknown): AgentSignal | null {
    const parsed = hookPayloadSchema.safeParse(payload);
    const signal = parsed.success ? mapEvent(parsed.data) : null;
    if (signal?.type !== 'failed' || signal.kind !== 'rate-limit') return signal;
    const resetAt = this.parseRateLimitReset(signal.message);
    return resetAt ? { ...signal, resetAt } : signal;
  }

  isWakePoint(payload: unknown): 'tool' | 'stop' | null {
    const parsed = hookPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.agent_id !== undefined) return null;
    switch (parsed.data.hook_event_name) {
      case 'PostToolUse':
        return 'tool';
      case 'Stop':
        return 'stop';
      default:
        return null;
    }
  }

  wakeReply(payload: unknown, pointer: string): object | null {
    const point = this.isWakePoint(payload);
    if (point === 'tool') {
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: pointer } };
    }
    return point === 'stop' ? { decision: 'block', reason: pointer } : null;
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
      ...(input.effort ? ['--effort', input.effort] : []),
      ...(input.orchestrator
        ? [
            '--plugin-dir',
            input.orchestrator.pluginDir,
            '--append-system-prompt',
            ORCHESTRATOR_PROMPT,
          ]
        : input.skills
          ? [
              '--plugin-dir',
              input.skills.pluginDir,
              '--append-system-prompt',
              rolePrompt(input.skills),
            ]
          : []),
    ];
    return {
      ...toSpawnCommand(input.executablePath, args, this.platform, process.env),
      cwd: input.cwd,
      env: {
        ...pactEnv(input),
        // The plugin's .mcp.json reads the token here: never in the arguments nor in a file.
        ...(input.orchestrator
          ? {
              PACT_ORCHESTRATOR_TOKEN: input.orchestrator.token,
              MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
            }
          : {}),
        // 004 R5: the plugin of another role reads the agent's own token.
        ...(input.agentMcp ? { PACT_AGENT_MCP_TOKEN: input.agentMcp.token } : {}),
      },
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
      // Agent teams (experimental): on for every agent, its teammates kept in-process, in the
      // agent's own terminal. Split panes would need tmux or iTerm2, outside PACT's tile.
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      teammateMode: 'in-process',
      // 005 R1 — the limits of the account, posted to PACT; the user's own line still printed.
      statusLine: {
        type: 'command',
        command: bridgeCommand(this.bridge, '--statusline'),
        refreshInterval: this.refreshInterval,
      },
      hooks: {
        // Claude Code refuses HTTP hooks for SessionStart (T049).
        SessionStart: hook({ type: 'command', command: bridgeCommand(this.bridge) }),
        UserPromptSubmit: hook(http),
        PostToolUse: hook(http),
        Notification: hook(http),
        Stop: hook(http),
        StopFailure: hook(http),
        PermissionRequest: hook({ ...http, timeout: PERMISSION_HOOK_TIMEOUT_S }),
      },
      ...permissions(level, input.orchestrator != null || input.agentMcp != null),
    };
  }
}

/** Only a question needs the user: what a teammate or subagent asks waits in the lead's terminal. */
/** « Actions sensibles » asks (R5 of 001); whoever has the access to PACT's tools uses them freely: the orchestrator (003 R2), and an agent that reads its events with get_events (007 R15). */
function permissions(level: PermissionLevel, pactTools: boolean) {
  const rules = {
    ...(pactTools ? { allow: [PACT_TOOLS] } : {}),
    ...(level === 'ask-sensitive' ? { ask: SENSITIVE_RULES } : {}),
  };
  return Object.keys(rules).length === 0 ? {} : { permissions: rules };
}

/** Claude Code's multiple-choice question tool (FR-024a). */
const QUESTION_TOOL = 'AskUserQuestion';

function mapEvent(event: HookPayload): AgentSignal | null {
  const signal = mapLeadEvent(event);
  if (event.agent_id === undefined || signal?.type === 'awaiting-answer') return signal;
  // Its turns, prompts and failures are its own: the state of the agent is its lead's.
  return null;
}

function mapLeadEvent(event: HookPayload): AgentSignal | null {
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
      // A question to choose from is not a permission: « 1 » would pick its first option (FR-024a).
      if (event.tool_name === QUESTION_TOOL) {
        const summary = event.tool_input?.questions?.[0]?.question ?? 'Claude pose une question';
        return { type: 'awaiting-answer', summary, question: true };
      }
      const tool = event.tool_name ?? 'Outil';
      const command = event.tool_input?.command;
      return command === undefined
        ? { type: 'awaiting-answer', summary: tool, ruleKey: tool }
        : { type: 'awaiting-answer', summary: command, ruleKey: `${tool}(${command})` };
    }
    case 'Notification':
      // Claude Code resumed by itself after a quota: PACT must not resume it too (FR-036).
      // Its `_stale` and `_disabled` siblings mean it will not: PACT's resume stays.
      if (event.notification_type === 'quota_auto_resume_fired')
        return { type: 'prompt-submitted' };
      if (event.notification_type === 'elicitation_dialog') {
        const summary = event.message ?? 'Claude pose une question';
        return { type: 'awaiting-answer', summary, question: true };
      }
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
