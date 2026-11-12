import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/main/agents/adapters/codex';
import type { CommandRunner, LaunchInput } from '../../src/main/agents/adapters/types';
import { runCliAdapterContract, type WakeCapable } from './cli-adapter.contract';

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
    expect(adapter.mapOutput('Trust this folder? Codex can read, edit…', {})).toMatchObject({
      type: 'awaiting-answer',
      summary: 'Faire confiance au dossier ?',
    });
    expect(adapter.mapOutput('Hooks need review\n4 hooks are new or changed.', {})).toMatchObject({
      type: 'awaiting-answer',
      summary: 'Approuver les hooks PACT ?',
    });
    expect(adapter.mapOutput('› Ask Codex to do anything', {})).toBeNull();
  });

  // #108 — captured on Codex 0.163: a digit moves the selection, Enter confirms; y does nothing.
  it('names the keys of its start screens: Enter on « Trust », 2 then Enter on « Trust all »', () => {
    const trust = adapter.mapOutput('Trust this folder?\n› 1. Trust and continue\n  2. Quit', {});
    expect(trust).toMatchObject({ keys: { allow: '1\r', deny: '\u001b' } });
    const hooks = adapter.mapOutput(
      'Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting',
      {},
    );
    expect(hooks).toMatchObject({ keys: { allow: '2\r', deny: '\u001b' } });
  });

  // #108 — Codex runs SessionStart at its first turn only.
  it('takes its quiet, empty prompt as the end of its start, and only once quiet', () => {
    const screen = '› Ask Codex to do anything\n  gpt-6 high · ~/repo\n  ? for shortcuts';
    expect(adapter.mapOutput(screen, { idleMs: 1500 })).toEqual({ type: 'session-started' });
    expect(adapter.mapOutput(screen, {})).toBeNull();
  });

  // #108 — a request the API refuses prints a banner and runs no Stop hook.
  it('ends the turn on an API error banner', () => {
    const banner =
      '■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported"}}';
    expect(adapter.mapOutput(banner, {})).toEqual({ type: 'turn-finished' });
    expect(
      adapter.mapOutput('• Handled the {"type":"error"} payload in the client', {}),
    ).toBeNull();
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

  it('ignores an agent merely talking about rate limits', () => {
    expect(adapter.mapOutput('• Added retry with backoff on rate limit errors', {})).toBeNull();
  });
});

describe('Codex detection', () => {
  // The real host: PATH is split and PATHEXT applied the way this OS does it.
  const host = process.platform;
  const bin = host === 'win32' ? 'codex.cmd' : 'codex';
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pact-codex-'));
    await writeFile(join(dir, bin), '#!/bin/sh\n');
    await chmod(join(dir, bin), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports codex as installed when hooks are available', async () => {
    expect(await create(host).detect({ PATH: dir })).toEqual({
      resolvedPath: join(dir, bin),
      version: '0.156.1',
      status: 'installed',
    });
  });

  it('reports codex as missing when it is not in PATH', async () => {
    expect(await create(host).detect({ PATH: '' })).toMatchObject({ status: 'missing' });
  });

  it('flags a codex without the hooks feature as unsupported-version', async () => {
    for (const features of [
      'hooks                                    under development  false',
      'apps                                     stable             true',
    ]) {
      const adapter = create(
        host,
        runner({ '--version': 'codex-cli 0.120.0', 'features list': features }),
      );
      expect(await adapter.detect({ PATH: dir })).toMatchObject({
        version: '0.120.0',
        status: 'unsupported-version',
      });
    }
  });

  it('flags a codex without the features command as unsupported-version', async () => {
    const adapter = create(host, runner({ '--version': 'codex-cli 0.40.0' }));
    expect(await adapter.detect({ PATH: dir })).toMatchObject({ status: 'unsupported-version' });
  });
});

describe('Codex with a role (004 T043, R3, R4)', () => {
  const dir = '/Users/me/Library/Application Support/PACT/roles/a 3/plugin/skills';
  const skillsOf = (role: 'orchestrator' | 'test') => ({
    role,
    pluginDir: '/p',
    skills: [{ name: `pact-${role}`, file: `${dir}/pact-${role}/SKILL.md` }],
    contract: `${dir}/pact-${role}/pact-contract.md`,
  });
  const url = 'http://127.0.0.1:4567/mcp';

  it('can be the orchestrator (FR-031)', () => {
    expect(create().supportsOrchestrator).toBe(true);
  });

  it('gives the orchestrator its skill, the pact server and a long tool timeout', () => {
    const skills = skillsOf('orchestrator');
    const orchestrator = { pluginDir: '/p', url, token: 'o'.repeat(64), skills };
    const spec = create().buildLaunch({ ...input, orchestrator, skills });
    const all = configs(spec.args);
    expect(all).toContain(
      `developer_instructions="Tu es l'agent orchestrateur de PACT. Lis et applique ${dir}/pact-orchestrator/SKILL.md et ${dir}/pact-orchestrator/pact-contract.md."`,
    );
    expect(all).toContain(`mcp_servers.pact.url="${url}"`);
    expect(all).toContain(
      'mcp_servers.pact.env_http_headers={ "X-Pact-Token" = "PACT_ORCHESTRATOR_TOKEN" }',
    );
    expect(all).toContain('mcp_servers.pact.tool_timeout_sec=660');
    expect(spec.env.PACT_ORCHESTRATOR_TOKEN).toBe(orchestrator.token);
    expect(spec.args.join(' ')).not.toContain(orchestrator.token);
  });

  it('gives an agent of another role its own token', () => {
    const skills = skillsOf('test');
    const agentMcp = { url, token: 't'.repeat(64), skills };
    const spec = create().buildLaunch({ ...input, agentMcp, skills });
    expect(configs(spec.args)).toContain(
      'mcp_servers.pact.env_http_headers={ "X-Pact-Token" = "PACT_AGENT_MCP_TOKEN" }',
    );
    expect(spec.env.PACT_AGENT_MCP_TOKEN).toBe(agentMcp.token);
    expect(spec.args.join(' ')).not.toContain(agentMcp.token);
  });

  it('adds none of it for an agent with no role', () => {
    const all = configs(create().buildLaunch(input).args).join(' ');
    expect(all).not.toContain('developer_instructions');
    expect(all).not.toContain('mcp_servers');
  });
});

describe('Codex model tiers and effort (004 T009)', () => {
  it('has no tiers until the CLI lists its models', () => {
    expect(create().modelTiers()).toEqual([]);
  });

  it('passes the effort as model_reasoning_effort, capped at high', () => {
    expect(create().supportsEffort).toBe(true);
    const effortOf = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') =>
      configs(create().buildLaunch({ ...input, effort }).args).filter((c) =>
        c.startsWith('model_reasoning_effort='),
      );
    expect(effortOf('low')).toEqual(['model_reasoning_effort=low']);
    expect(effortOf('medium')).toEqual(['model_reasoning_effort=medium']);
    expect(effortOf('max')).toEqual(['model_reasoning_effort=high']);
    expect(configs(create().buildLaunch(input).args).join(' ')).not.toContain(
      'model_reasoning_effort',
    );
  });
});

// 007 US2, contracts/hooks.md — Codex has no PostToolUse (HOOK_EVENTS) and Stop is not validated to
// extend a turn: its pointer is typed at the end of the turn.
describe('Codex wake points (007 T031)', () => {
  const wake = new CodexAdapter({
    platform: 'darwin',
    bridge,
    run: installed,
  }) as unknown as WakeCapable;

  it('cannot carry a pointer in the middle of a turn', () => {
    expect(wake.midTurnWake).toBe(false);
  });

  it('has no wake point and no reply, for the hooks it does follow', () => {
    expect(wake.midTurnWake).toBe(false);
    for (const hook_event_name of ['Stop', 'PostToolUse', 'UserPromptSubmit']) {
      expect(wake.isWakePoint?.({ hook_event_name }) ?? null).toBeNull();
      expect(
        wake.wakeReply?.({ hook_event_name }, '1 événement, lis get_events') ?? null,
      ).toBeNull();
    }
  });

  it('does not add PostToolUse to the hooks it installs', () => {
    const spec = new CodexAdapter({ platform: 'darwin', bridge, run: installed }).buildLaunch({
      agentId: '00000000-0000-4000-8000-000000000001',
      executablePath: '/opt/bin/codex',
      repoPath: '/repo',
      cwd: '/repo/.worktrees/codex-1',
      model: null,
      permissionLevel: 'always-allow',
      sessionId: '11111111-2222-4333-8444-555555555555',
      port: 3001,
      hook: { url: 'http://127.0.0.1:4567', token: 'f'.repeat(64) },
    });
    expect(spec.args.join(' ')).not.toContain('PostToolUse');
    expect(wake.midTurnWake).toBe(false);
  });
});
