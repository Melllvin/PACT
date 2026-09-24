import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/main/agents/adapters/codex';
import type { CommandRunner, LaunchInput } from '../../src/main/agents/adapters/types';
import { runCliAdapterContract } from './cli-adapter.contract';

// research.md R4–R6 and « Caractérisation T049 » (Codex 0.156.1).

const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/app/hook.js' };

const FEATURES_WITH_HOOKS = `apps                                     stable             true
hooks                                    stable             true
plugin_hooks                             removed            false`;

/** Fake `codex --version` / `codex features list` answers, keyed by the joined arguments. */
const runner =
  (answers: Record<string, string>): CommandRunner =>
  (_file, args) => {
    const answer = answers[args.join(' ')];
    return answer === undefined ? Promise.reject(new Error('boom')) : Promise.resolve(answer);
  };

const installed = runner({
  '--version': 'codex-cli 0.156.1\n',
  'features list': FEATURES_WITH_HOOKS,
});

const create = (platform: NodeJS.Platform = 'darwin', run: CommandRunner = installed) =>
  new CodexAdapter({ platform, bridge, run });

runCliAdapterContract('codex', ({ platform }) => create(platform));

const input: LaunchInput = {
  agentId: '00000000-0000-4000-8000-000000000002',
  executablePath: '/opt/homebrew/bin/codex',
  repoPath: '/Users/me/Développement/app',
  cwd: '/Users/me/Développement/app/.worktrees/codex-2',
  model: null,
  permissionLevel: 'always-allow',
  port: 3002,
  hook: { url: 'http://127.0.0.1:4567', token: 'e'.repeat(64) },
};

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configs = (args: string[]) => args.filter((_, i) => args[i - 1] === '-c');

describe('Codex launch arguments', () => {
  it.each([
    ['always-allow', 'never', 'workspace-write'],
    ['ask-sensitive', 'on-request', 'workspace-write'],
    ['always-ask', 'on-request', 'read-only'],
  ] as const)('maps %s to -a %s -s %s', (permissionLevel, approval, sandbox) => {
    const { args } = create().buildLaunch({ ...input, permissionLevel });
    expect(valueAfter(args, '-a')).toBe(approval);
    expect(valueAfter(args, '-s')).toBe(sandbox);
  });

  it('keeps the main repository .git writable so the agent can commit from its worktree', () => {
    for (const permissionLevel of ['always-allow', 'ask-sensitive', 'always-ask'] as const) {
      expect(configs(create().buildLaunch({ ...input, permissionLevel }).args)).toContain(
        'sandbox_workspace_write.writable_roots=["/Users/me/Développement/app/.git"]',
      );
    }
  });

  it('never bypasses the sandbox nor the hook trust review', () => {
    for (const permissionLevel of ['always-allow', 'ask-sensitive', 'always-ask'] as const) {
      const line = create()
        .buildLaunch({ ...input, permissionLevel })
        .args.join(' ');
      expect(line).not.toMatch(/danger-full-access|dangerously-bypass|--yolo/);
    }
  });

  it('turns off the startup update prompt, which Enter would accept (T049)', () => {
    expect(configs(create().buildLaunch(input).args)).toContain(
      'check_for_update_on_startup=false',
    );
  });

  it('injects the hooks with -c only, through the hook bridge', () => {
    const hooks = configs(create().buildLaunch(input).args).filter((c) => c.startsWith('hooks.'));
    const command = JSON.stringify(
      `ELECTRON_RUN_AS_NODE=1 '${bridge.executable}' '${bridge.script}'`,
    );
    expect(hooks).toEqual(
      ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'].map(
        (event) => `hooks.${event}=[{hooks=[{type="command",command=${command}}]}]`,
      ),
    );
  });

  it('adds notify as the degraded-mode signal when the hooks are not trusted', () => {
    expect(configs(create().buildLaunch(input).args)).toContain(
      `notify=["/usr/bin/env","ELECTRON_RUN_AS_NODE=1","${bridge.executable}","${bridge.script}","--notify"]`,
    );
  });

  it('leaves notify out on Windows, where it was not characterized', () => {
    const args = create('win32').buildLaunch({ ...input, executablePath: 'C:\\codex.exe' }).args;
    expect(configs(args).some((c) => c.startsWith('notify='))).toBe(false);
  });

  it('never puts the hook token in the process arguments', () => {
    expect(create().buildLaunch(input).args.join(' ')).not.toContain(input.hook.token);
  });

  it('passes the chosen model', () => {
    expect(valueAfter(create().buildLaunch({ ...input, model: 'gpt-6-sol' }).args, '-m')).toBe(
      'gpt-6-sol',
    );
    expect(create().buildLaunch(input).args).not.toContain('-m');
  });

  it('resumes with codex resume <SESSION_ID> and the same options', () => {
    const launch = create().buildLaunch(input).args;
    const resume = create().buildResume({ ...input, sessionId: '01a0d37e-0c4e' }).args;
    expect(resume.slice(0, 2)).toEqual(['resume', '01a0d37e-0c4e']);
    expect(resume.slice(2)).toEqual(launch);
  });
});

describe('Codex hook payloads (captured in T049)', () => {
  const common = {
    session_id: '01a0d37e-0c4e-7571-a710-0130b6ee0560',
    transcript_path: '/Users/me/.codex/sessions/rollout.jsonl',
    cwd: input.cwd,
    model: 'gpt-6-sol',
    permission_mode: 'default',
  };
  const adapter = create();

  it('SessionStart → session-started with the id codex resume needs', () => {
    expect(
      adapter.mapHookEvent({ ...common, hook_event_name: 'SessionStart', source: 'startup' }),
    ).toEqual({ type: 'session-started', sessionId: common.session_id });
  });

  it('UserPromptSubmit → prompt-submitted', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        turn_id: 't',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Ajoute un test',
      }),
    ).toEqual({ type: 'prompt-submitted', prompt: 'Ajoute un test' });
  });

  it('PermissionRequest → awaiting-answer with the command', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch approve.txt', description: 'Allow?' },
      }),
    ).toEqual({
      type: 'awaiting-answer',
      summary: 'touch approve.txt',
      ruleKey: 'Bash(touch approve.txt)',
    });
  });

  it('Stop → turn-finished for that session', () => {
    expect(
      adapter.mapHookEvent({
        ...common,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'ok',
      }),
    ).toEqual({ type: 'turn-finished', sessionId: common.session_id });
  });

  it('notify agent-turn-complete → turn-finished for its thread', () => {
    expect(
      adapter.mapHookEvent({
        type: 'agent-turn-complete',
        'thread-id': common.session_id,
        'turn-id': 't',
        client: 'codex-tui',
        'input-messages': ['Ajoute un test'],
        'last-assistant-message': 'Fait.',
      }),
    ).toEqual({ type: 'turn-finished', sessionId: common.session_id });
  });

  it("ignores the notify of Codex's internal title thread", () => {
    expect(
      adapter.mapHookEvent({
        type: 'agent-turn-complete',
        'thread-id': 'other-thread',
        'input-messages': [
          'Generate a concise, single-line task title of at most 36 characters…\n\nUser prompt:\nok',
        ],
        'last-assistant-message': '{"title":"Reply ok"}',
      }),
    ).toBeNull();
  });
});

describe('Codex terminal and dialogs', () => {
  const adapter = create();

  it('approves with y and refuses with Escape', () => {
    expect(adapter.answerKeys('allow')).toBe('y');
    expect(adapter.answerKeys('deny')).toBe('\u001b');
  });

  it('reports the folder trust and hook review screens, which PACT never answers itself', () => {
    expect(adapter.mapOutput('Trust this folder? Codex can read, edit…', {})).toEqual({
      type: 'awaiting-answer',
      summary: 'Faire confiance au dossier ?',
    });
    expect(adapter.mapOutput('Hooks need review\n4 hooks are new or changed.', {})).toEqual({
      type: 'awaiting-answer',
      summary: 'Approuver les hooks PACT ?',
    });
    expect(adapter.mapOutput('› Ask Codex to do anything', {})).toBeNull();
  });

  it('recognises a usage limit and its reset time', () => {
    const now = new Date(2026, 8, 24, 14, 0);
    const codex = new CodexAdapter({ platform: 'darwin', bridge, run: installed, now: () => now });
    const message = "■ You've hit your usage limit. Try again at 3:45 PM.";
    expect(codex.mapOutput(message, {})).toEqual({
      type: 'failed',
      kind: 'rate-limit',
      message,
      resetAt: new Date(2026, 8, 24, 15, 45),
    });
    expect(codex.parseRateLimitReset('Try again at 9 AM')).toEqual(new Date(2026, 8, 25, 9, 0));
    expect(codex.parseRateLimitReset('Try again later')).toBeNull();
  });
});

describe('Codex detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pact-codex-'));
    await writeFile(join(dir, 'codex'), '#!/bin/sh\n');
    await chmod(join(dir, 'codex'), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports codex as installed when hooks are available', async () => {
    expect(await create().detect({ PATH: dir })).toEqual({
      resolvedPath: join(dir, 'codex'),
      version: '0.156.1',
      status: 'installed',
    });
  });

  it('reports codex as missing when it is not in PATH', async () => {
    expect(await create().detect({ PATH: '' })).toMatchObject({ status: 'missing' });
  });

  it('flags a codex without the hooks feature as unsupported-version', async () => {
    for (const features of [
      'hooks                                    under development  false',
      'apps                                     stable             true',
    ]) {
      const adapter = create(
        'darwin',
        runner({ '--version': 'codex-cli 0.120.0', 'features list': features }),
      );
      expect(await adapter.detect({ PATH: dir })).toMatchObject({
        version: '0.120.0',
        status: 'unsupported-version',
      });
    }
  });

  it('flags a codex without the features command as unsupported-version', async () => {
    const adapter = create('darwin', runner({ '--version': 'codex-cli 0.40.0' }));
    expect(await adapter.detect({ PATH: dir })).toMatchObject({ status: 'unsupported-version' });
  });
});
