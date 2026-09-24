import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliAdapter, LaunchInput } from '../../src/main/agents/adapters/types';
import { PtyManager } from '../../src/main/pty/pty-manager';

// contracts/cli-adapter.md — the shared suite every adapter must pass.

export type AdapterFactory = (options: { platform: NodeJS.Platform }) => CliAdapter;

type ContractOptions = {
  /** Real executable used for launch tests (defaults to a placeholder path). */
  executablePath?: string;
  /** Obligation 5 needs an adapter able to drive the fake CLI's permission scenario. */
  drivesFakeCli?: { env: Record<string, string> };
};

const LEVELS = ['always-allow', 'ask-sensitive', 'always-ask'] as const;

export function runCliAdapterContract(
  name: string,
  factory: AdapterFactory,
  { executablePath = '/opt/bin/agent', drivesFakeCli }: ContractOptions = {},
) {
  const adapter = factory({ platform: process.platform });
  const input: LaunchInput = {
    agentId: '00000000-0000-4000-8000-000000000001',
    executablePath,
    cwd: '/repo/.worktrees/agent-1',
    model: null,
    permissionLevel: 'ask-sensitive',
    // Fixed so argument comparisons only reflect what the test varies.
    sessionId: 'session-1',
    port: 3001,
    hook: { url: 'http://127.0.0.1:4567', token: 'a'.repeat(64) },
  };

  describe(`${name} adapter contract`, () => {
    it('1. launches in the agent worktree with the PACT environment', () => {
      const spec = adapter.buildLaunch(input);
      expect(spec.cwd).toBe(input.cwd);
      expect(spec.env).toMatchObject({
        PORT: '3001',
        PACT_PORT: '3001',
        PACT_HOOK_URL: input.hook.url,
        PACT_AGENT_TOKEN: input.hook.token,
        PACT_AGENT_ID: input.agentId,
      });
    });

    it('2. maps each permission level to distinct arguments', () => {
      const argsFor = LEVELS.map((level) =>
        JSON.stringify(adapter.buildLaunch({ ...input, permissionLevel: level }).args),
      );
      expect(new Set(argsFor).size).toBe(LEVELS.length);
    });

    it('2. falls back to the most cautious level for an unsupported one', () => {
      const unknown = {
        ...input,
        permissionLevel: 'bypass' as unknown as LaunchInput['permissionLevel'],
      };
      const cautious = adapter.buildLaunch({ ...input, permissionLevel: 'always-ask' });
      expect(adapter.buildLaunch(unknown).args).toEqual(cautious.args);
    });

    it('3. resumes the same session with the same permission level', () => {
      const launch = adapter.buildLaunch({ ...input, sessionId: 'session-42' });
      const resume = adapter.buildResume({ ...input, sessionId: 'session-42' });
      expect(resume.args.join(' ')).toContain('session-42');
      expect(resume.cwd).toBe(launch.cwd);
      const permissionArgs = (args: string[]) =>
        args.filter((arg) => !arg.includes('session') && arg !== 'session-42');
      expect(permissionArgs(resume.args)).toEqual(
        expect.arrayContaining(permissionArgs(launch.args)),
      );
    });

    it('4. ignores invalid hook payloads without throwing', () => {
      for (const payload of [
        null,
        undefined,
        42,
        'text',
        [],
        {},
        { type: 'unknown' },
        { type: 5 },
      ]) {
        expect(adapter.mapHookEvent(payload)).toBeNull();
      }
    });

    it('6. launches Windows .cmd shims through cmd.exe /d /s /c', () => {
      const windows = factory({ platform: 'win32' });
      const spec = windows.buildLaunch({ ...input, executablePath: 'C:\\npm\\agent.cmd' });
      expect(spec.file.toLowerCase()).toMatch(/cmd(\.exe)?$/);
      expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(spec.windowsVerbatimArguments).toBe(true);
    });

    describe.runIf(drivesFakeCli)('5. with the fake CLI in a real terminal', () => {
      let manager: PtyManager | undefined;
      let dir: string | undefined;

      afterEach(async () => {
        await manager?.dispose();
        if (dir) await rm(dir, { recursive: true, force: true });
      });

      it.each(['allow', 'deny'] as const)(
        'answerKeys(%s) unblocks a permission question',
        async (answer) => {
          dir = await mkdtemp(join(tmpdir(), 'pact-contract-'));
          const pty = new PtyManager();
          manager = pty;
          let output = '';
          pty.onData((_id, data) => (output += data));
          const waitFor = async (text: string) => {
            for (let i = 0; i < 500 && !output.includes(text); i++)
              await new Promise((r) => setTimeout(r, 20));
            expect(output).toContain(text);
          };

          const spec = adapter.buildLaunch({ ...input, cwd: dir });
          pty.start('agent', { ...spec, env: { ...drivesFakeCli?.env, ...spec.env } });
          await waitFor('> ');
          pty.write('agent', 'Nettoie\r');
          await waitFor('(allow/deny)');
          pty.write('agent', adapter.answerKeys(answer));
          await waitFor(answer === 'allow' ? 'Autorisé' : 'Refusé');
        },
      );
    });
  });
}
