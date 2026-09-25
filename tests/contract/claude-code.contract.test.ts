import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/main/agents/adapters/claude-code';
import type { CommandRunner, LaunchInput } from '../../src/main/agents/adapters/types';
import { runCliAdapterContract } from './cli-adapter.contract';

// research.md R4–R6 and « Caractérisation T049 » (Claude Code 2.1.281).

const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/app/hook.js' };

const HELP_WITH_AUTO = `  --permission-mode <mode>  Permission mode to use for the session
                            (choices: "acceptEdits", "auto", "bypassPermissions", "manual",
                            "dontAsk", "plan")`;

/** Fake `claude --version` / `claude --help` answers, keyed by the first argument. */
const runner =
  (answers: Record<string, string>): CommandRunner =>
  (_file, args) => {
    const answer = answers[args[0] ?? ''];
    return answer === undefined ? Promise.reject(new Error('boom')) : Promise.resolve(answer);
  };

const installed = runner({ '--version': '2.1.281 (Claude Code)\n', '--help': HELP_WITH_AUTO });

const create = (platform: NodeJS.Platform = 'darwin', run: CommandRunner = installed) =>
  new ClaudeCodeAdapter({ platform, bridge, run });

runCliAdapterContract('claude-code', ({ platform }) => create(platform));

const input: LaunchInput = {
  agentId: '00000000-0000-4000-8000-000000000001',
  executablePath: '/opt/homebrew/bin/claude',
  repoPath: '/repo',
  cwd: '/repo/.worktrees/claude-code-1',
  model: null,
  permissionLevel: 'always-allow',
  sessionId: '11111111-2222-4333-8444-555555555555',
  port: 3001,
  hook: { url: 'http://127.0.0.1:4567', token: 'f'.repeat(64) },
};

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

type Settings = {
  hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
  permissions?: { ask?: string[] };
};
const settingsOf = (args: string[]) => JSON.parse(valueAfter(args, '--settings') ?? '') as Settings;

describe('Claude Code launch arguments', () => {
  it.each([
    ['always-allow', 'auto'],
    ['ask-sensitive', 'acceptEdits'],
    ['always-ask', 'manual'],
  ] as const)('maps %s to --permission-mode %s', (permissionLevel, mode) => {
    const { args } = create().buildLaunch({ ...input, permissionLevel });
    expect(valueAfter(args, '--permission-mode')).toBe(mode);
  });

  it('asks before sensitive actions through permissions.ask rules', () => {
    const { args } = create().buildLaunch({ ...input, permissionLevel: 'ask-sensitive' });
    expect(settingsOf(args).permissions?.ask).toEqual(
      expect.arrayContaining(['Bash(rm *)', 'Bash(curl *)', 'Bash(wget *)', 'WebFetch']),
    );
    const allowAll = create().buildLaunch(input).args;
    expect(settingsOf(allowAll).permissions).toBeUndefined();
  });

  // Claude Code only writes in the folder it starts in; beyond it, it asks, even in acceptEdits.
  // PACT keeps that folder the worktree and never widens it (T138, research.md R5).
  it('leaves writes outside the worktree to an explicit approval', () => {
    for (const permissionLevel of ['always-allow', 'ask-sensitive', 'always-ask'] as const) {
      const spec = create().buildLaunch({ ...input, permissionLevel });
      expect(spec.cwd).toBe(input.cwd);
      expect(spec.args).not.toContain('--add-dir');
      expect(spec.args.join(' ')).not.toContain('additionalDirectories');
    }
  });

  it('never bypasses permissions, whatever the level', () => {
    for (const permissionLevel of ['always-allow', 'ask-sensitive', 'always-ask'] as const) {
      const line = create()
        .buildLaunch({ ...input, permissionLevel })
        .args.join(' ');
      expect(line).not.toMatch(/bypassPermissions|dangerously-skip-permissions|dontAsk/);
    }
  });

  it('starts the session PACT chose and resumes it by id', () => {
    const launch = create().buildLaunch(input).args;
    expect(valueAfter(launch, '--session-id')).toBe(input.sessionId);
    expect(launch).not.toContain('--resume');

    const resume = create().buildResume({ ...input, sessionId: 'abc' }).args;
    expect(valueAfter(resume, '--resume')).toBe('abc');
    expect(resume).not.toContain('--session-id');
  });

  it('generates a session id when none is given', () => {
    const withoutSession: LaunchInput = { ...input };
    delete withoutSession.sessionId;
    const id = valueAfter(create().buildLaunch(withoutSession).args, '--session-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes the chosen model', () => {
    expect(valueAfter(create().buildLaunch({ ...input, model: 'opus' }).args, '--model')).toBe(
      'opus',
    );
    expect(create().buildLaunch(input).args).not.toContain('--model');
  });

  it('sends every hook but SessionStart over HTTP, with the token read from the environment', () => {
    const { hooks } = settingsOf(create().buildLaunch(input).args);
    for (const event of ['UserPromptSubmit', 'Notification', 'Stop', 'StopFailure']) {
      expect(hooks[event]?.[0]?.hooks[0]).toEqual({
        type: 'http',
        url: input.hook.url,
        headers: { 'X-Pact-Token': '$PACT_AGENT_TOKEN' },
        allowedEnvVars: ['PACT_AGENT_TOKEN'],
      });
    }
    // PermissionRequest waits for the user's answer (« Toujours pour ce worktree », FR-034).
    expect(hooks.PermissionRequest?.[0]?.hooks[0]).toMatchObject({ type: 'http', timeout: 600 });
  });

  it('runs SessionStart through the hook bridge, since HTTP hooks are not accepted there', () => {
    const { hooks } = settingsOf(create().buildLaunch(input).args);
    expect(hooks.SessionStart?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: `ELECTRON_RUN_AS_NODE=1 '${bridge.executable}' '${bridge.script}'`,
    });
  });

  it('never puts the hook token in the process arguments', () => {
    const line = create().buildLaunch(input).args.join(' ');
    expect(line).not.toContain(input.hook.token);
  });

  it('does not force Electron into Node mode for the agent itself', () => {
    expect(create().buildLaunch(input).env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('runs the resolved executable directly on macOS', () => {
    expect(create().buildLaunch(input).file).toBe(input.executablePath);
  });
});

describe('Claude Code hook payloads (captured in T049)', () => {
  const common = {
    session_id: input.sessionId,
    transcript_path: '/Users/me/.claude/projects/x/s.jsonl',
    cwd: input.cwd,
  };
  const adapter = create();

  it('SessionStart → session-started with its session id', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude-opus-5-5',
      }),
    ).toEqual({ type: 'session-started', sessionId: input.sessionId });
  });

  it('UserPromptSubmit → prompt-submitted with the typed prompt', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        prompt_id: 'p',
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Ajoute un test',
      }),
    ).toEqual({ type: 'prompt-submitted', prompt: 'Ajoute un test' });
  });

  it('PermissionRequest → awaiting-answer, summarised by the command and keyed by tool', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm probe.txt', description: 'Delete probe' },
        permission_suggestions: [],
      }),
    ).toEqual({ type: 'awaiting-answer', summary: 'rm probe.txt', ruleKey: 'Bash(rm probe.txt)' });
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'PermissionRequest',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com' },
      }),
    ).toEqual({ type: 'awaiting-answer', summary: 'WebFetch', ruleKey: 'WebFetch' });
  });

  it('allows a request from the PermissionRequest hook reply (« Toujours pour ce worktree »)', () => {
    expect(adapter.permissionDecision('allow')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('Notification permission_prompt → awaiting-answer; idle_prompt is not a new state', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
        notification_type: 'permission_prompt',
      }),
    ).toEqual({ type: 'awaiting-answer', summary: 'Claude needs your permission' });
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        notification_type: 'idle_prompt',
      }),
    ).toBeNull();
  });

  it('Stop → turn-finished', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'Fait.',
      }),
    ).toEqual({ type: 'turn-finished' });
  });

  it('StopFailure → failed, rate-limit when the error says so', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: "You've hit your limit",
      }),
    ).toEqual({ type: 'failed', kind: 'rate-limit', message: "You've hit your limit" });
    expect(
      adapter.mapHookEvent({ ...common, hook_event_name: 'StopFailure', error: 'server_error' }),
    ).toEqual({ type: 'failed', kind: 'crash', message: 'server_error' });
  });

  it('StopFailure on a rate limit gives its reset time when the message has one (T104)', () => {
    const now = new Date(2026, 8, 24, 14, 0);
    const timed = new ClaudeCodeAdapter({
      platform: 'darwin',
      bridge,
      run: installed,
      now: () => now,
    });
    expect(
      timed.mapHookEvent({
        ...common,
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: "You've hit your limit · resets 3pm",
      }),
    ).toEqual({
      type: 'failed',
      kind: 'rate-limit',
      message: "You've hit your limit · resets 3pm",
      resetAt: new Date(2026, 8, 24, 15, 0),
    });
  });

  it('quota_auto_resume_fired: Claude Code resumed on its own, as if a prompt was sent (FR-036)', () => {
    const quota = (notification_type: string) =>
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'Notification',
        message: 'Resuming',
        notification_type,
      });
    expect(quota('quota_auto_resume_fired')).toEqual({ type: 'prompt-submitted' });
    // Stale or disabled: Claude Code will not resume, PACT's resume stays.
    expect(quota('quota_auto_resume_stale')).toBeNull();
    expect(quota('quota_auto_resume_disabled')).toBeNull();
  });

  it('ignores SessionEnd and events PACT does not use', () => {
    expect(
      adapter.mapHookEvent({ ...common, hook_event_name: 'SessionEnd', reason: 'other' }),
    ).toBeNull();
    expect(adapter.mapHookEvent({ ...common, hook_event_name: 'PreToolUse' })).toBeNull();
  });
});

describe('Claude Code terminal and dialogs', () => {
  const adapter = create();

  it('approves with 1 and refuses with Escape, valid whatever the number of options', () => {
    expect(adapter.answerKeys('allow')).toBe('1');
    expect(adapter.answerKeys('deny')).toBe('\u001b');
  });

  it('reports the folder trust question, which sends no hook', () => {
    expect(
      adapter.mapOutput(
        'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder',
        {},
      ),
    ).toEqual({ type: 'awaiting-answer', summary: 'Faire confiance au dossier ?' });
    expect(adapter.mapOutput('❯ Ajoute un test', {})).toBeNull();
  });

  it('reads the reset hour of a rate-limit message as the next such time', () => {
    const now = new Date(2026, 8, 24, 14, 0);
    const at = (text: string) =>
      new ClaudeCodeAdapter({
        platform: 'darwin',
        bridge,
        run: installed,
        now: () => now,
      }).parseRateLimitReset(text);
    expect(at("You've hit your limit · resets 3pm")).toEqual(new Date(2026, 8, 24, 15, 0));
    expect(at('Limit reached ∙ resets 9:30am')).toEqual(new Date(2026, 8, 25, 9, 30));
    expect(at('Limit reached')).toBeNull();
  });
});

describe('Claude Code detection', () => {
  // The real host: PATH is split and PATHEXT applied the way this OS does it.
  const host = process.platform;
  const bin = host === 'win32' ? 'claude.cmd' : 'claude';
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pact-claude-'));
    await writeFile(join(dir, bin), '#!/bin/sh\n');
    await chmod(join(dir, bin), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports claude as installed with its version', async () => {
    expect(await create(host).detect({ PATH: dir })).toEqual({
      resolvedPath: join(dir, bin),
      version: '2.1.281',
      status: 'installed',
    });
  });

  it('reports claude as missing when it is not in PATH', async () => {
    expect(await create(host).detect({ PATH: '' })).toEqual({
      resolvedPath: null,
      version: null,
      status: 'missing',
    });
  });

  it('flags a version older than 2.1 as unsupported', async () => {
    const adapter = create(
      host,
      runner({ '--version': '1.0.44 (Claude Code)', '--help': HELP_WITH_AUTO }),
    );
    expect(await adapter.detect({ PATH: dir })).toMatchObject({
      version: '1.0.44',
      status: 'unsupported-version',
    });
  });

  it('keeps the CLI usable when --version fails', async () => {
    expect(await create(host, runner({})).detect({ PATH: dir })).toEqual({
      resolvedPath: join(dir, bin),
      version: null,
      status: 'installed',
    });
  });

  it('falls back to acceptEdits when this Claude Code has no auto mode', async () => {
    const adapter = create(
      host,
      runner({ '--version': '2.1.0 (Claude Code)', '--help': '--permission-mode <mode>' }),
    );
    await adapter.detect({ PATH: dir });
    expect(valueAfter(adapter.buildLaunch(input).args, '--permission-mode')).toBe('acceptEdits');
  });

  it('offers no model list of its own', async () => {
    expect(await create(host).listModels()).toEqual([]);
  });
});
