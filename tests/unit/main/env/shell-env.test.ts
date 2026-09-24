import { describe, expect, it, vi } from 'vitest';
import {
  createShellEnvResolver,
  ENV_MARKER,
  execFileRunner,
  parseShellEnv,
  SHELL_ENV_TIMEOUT_MS,
  type ShellRunner,
} from '../../../../src/main/env/shell-env';

const output = (entries: string[], noise = '') => `${noise}${ENV_MARKER}\n${entries.join('\0')}\0`;

describe('parseShellEnv', () => {
  it('ignores whatever an interactive login shell prints before the marker', () => {
    const noise = 'Last login: Wed Sep 24\nWelcome!\nHOME=/not/real\n';
    expect(parseShellEnv(output(['PATH=/opt/bin:/usr/bin'], noise))).toEqual({
      PATH: '/opt/bin:/usr/bin',
    });
  });

  it('keeps multi-line values and values containing "="', () => {
    expect(parseShellEnv(output(['PS1=line1\nline2', 'OPTS=a=b=c']))).toEqual({
      PS1: 'line1\nline2',
      OPTS: 'a=b=c',
    });
  });

  it('skips entries without a variable name', () => {
    expect(parseShellEnv(output(['=weird', 'noequals', 'OK=1']))).toEqual({ OK: '1' });
  });

  it('returns null when the marker is missing (the shell did not run the command)', () => {
    expect(parseShellEnv('PATH=/usr/bin\0')).toBeNull();
  });
});

describe('createShellEnvResolver', () => {
  const baseEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', HOME: '/Users/me' };

  it('on Windows returns the process environment without starting a shell', async () => {
    const run = vi.fn<ShellRunner>();
    const resolve = createShellEnvResolver({ platform: 'win32', baseEnv, run });
    expect(await resolve()).toEqual(baseEnv);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the login shell interactively with a 3 s timeout', async () => {
    const run = vi.fn<ShellRunner>().mockResolvedValue(output(['PATH=/Users/me/.local/bin']));
    await createShellEnvResolver({ platform: 'darwin', baseEnv, run })();
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('env -0')], 3000);
    expect(SHELL_ENV_TIMEOUT_MS).toBe(3000);
  });

  it('lets the shell environment override the minimal Finder environment', async () => {
    const run = vi
      .fn<ShellRunner>()
      .mockResolvedValue(output(['PATH=/Users/me/.local/bin:/usr/bin']));
    const env = await createShellEnvResolver({ platform: 'darwin', baseEnv, run })();
    expect(env).toEqual({ ...baseEnv, PATH: '/Users/me/.local/bin:/usr/bin' });
  });

  it('falls back to /bin/sh when SHELL is not set', async () => {
    const run = vi.fn<ShellRunner>().mockResolvedValue(output([]));
    await createShellEnvResolver({ platform: 'darwin', baseEnv: { PATH: '/usr/bin' }, run })();
    expect(run).toHaveBeenCalledWith('/bin/sh', expect.any(Array), 3000);
  });

  it.each([
    ['times out or fails', () => Promise.reject(new Error('timeout'))],
    ['prints no marker', () => Promise.resolve('broken')],
  ])('falls back to the process environment when the shell %s', async (_case, impl) => {
    const env = await createShellEnvResolver({ platform: 'linux', baseEnv, run: impl })();
    expect(env).toEqual(baseEnv);
  });

  it('drops undefined variables from the process environment', async () => {
    const run = vi.fn<ShellRunner>().mockRejectedValue(new Error('x'));
    const env = await createShellEnvResolver({
      platform: 'darwin',
      baseEnv: { A: '1', B: undefined },
      run,
    })();
    expect(env).toEqual({ A: '1' });
  });

  it('resolves once and caches the result, even for concurrent callers', async () => {
    const run = vi.fn<ShellRunner>().mockResolvedValue(output(['X=1']));
    const resolve = createShellEnvResolver({ platform: 'darwin', baseEnv, run });
    const [first, second] = await Promise.all([resolve(), resolve()]);
    await resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe.skipIf(process.platform === 'win32')('execFileRunner with a real shell', () => {
  it('reads the environment of /bin/sh', async () => {
    const resolve = createShellEnvResolver({
      platform: process.platform,
      baseEnv: { SHELL: '/bin/sh', PACT_PROBE: 'kept' },
      run: execFileRunner,
    });
    const env = await resolve();
    expect(env.PACT_PROBE).toBe('kept');
    expect(env.PATH).toBeTruthy();
  });

  it('rejects when the command exceeds the timeout', async () => {
    await expect(execFileRunner('/bin/sh', ['-c', 'sleep 5'], 50)).rejects.toThrow();
  });
});
