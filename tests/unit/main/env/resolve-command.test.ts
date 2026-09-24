import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable, toSpawnCommand } from '../../../../src/main/env/resolve-command';

const isWindows = process.platform === 'win32';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-resolve-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const touch = async (path: string, mode = 0o755) => {
  await writeFile(path, '');
  await chmod(path, mode);
};

describe('findExecutable', () => {
  it('returns the first match in PATH order', async () => {
    const [first, second] = [join(root, 'a'), join(root, 'b')];
    await mkdir(first);
    await mkdir(second);
    await touch(join(first, 'tool'));
    await touch(join(second, 'tool'));
    const path = [first, second].join(':');
    expect(await findExecutable('tool', { PATH: path }, 'darwin')).toBe(join(first, 'tool'));
  });

  it('returns null when the command is not found', async () => {
    expect(await findExecutable('nope', { PATH: root }, 'darwin')).toBeNull();
    expect(await findExecutable('nope', {}, 'darwin')).toBeNull();
  });

  it.skipIf(isWindows)('skips files that are not executable on POSIX', async () => {
    await touch(join(root, 'tool'), 0o644);
    expect(await findExecutable('tool', { PATH: root }, 'darwin')).toBeNull();
  });

  it('skips directories named like the command', async () => {
    await mkdir(join(root, 'tool'));
    expect(await findExecutable('tool', { PATH: root }, 'darwin')).toBeNull();
  });

  it('accepts an explicit path to an executable', async () => {
    await touch(join(root, 'tool'));
    expect(await findExecutable(join(root, 'tool'), {}, 'darwin')).toBe(join(root, 'tool'));
  });

  it('on Windows tries PATHEXT extensions and splits PATH on ";"', async () => {
    const [first, second] = [join(root, 'a'), join(root, 'b')];
    await mkdir(first);
    await mkdir(second);
    await touch(join(second, 'codex.cmd'));
    const env = { Path: `${first};${second}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(await findExecutable('codex', env, 'win32')).toBe(join(second, 'codex.cmd'));
  });

  it('on Windows prefers .exe over .cmd following PATHEXT order', async () => {
    await touch(join(root, 'claude.cmd'));
    await touch(join(root, 'claude.exe'));
    const env = { PATH: root, PATHEXT: '.EXE;.CMD' };
    expect(await findExecutable('claude', env, 'win32')).toBe(join(root, 'claude.exe'));
  });
});

describe('toSpawnCommand', () => {
  it('runs POSIX executables directly', () => {
    expect(toSpawnCommand('/usr/local/bin/claude', ['--resume', 'x'], 'darwin', {})).toEqual({
      file: '/usr/local/bin/claude',
      args: ['--resume', 'x'],
      windowsVerbatimArguments: false,
    });
  });

  it('runs Windows .exe files directly', () => {
    const exe = 'C:\\Program Files\\Claude\\claude.exe';
    expect(toSpawnCommand(exe, ['a b'], 'win32', {})).toEqual({
      file: exe,
      args: ['a b'],
      windowsVerbatimArguments: false,
    });
  });

  it.each(['codex.cmd', 'tool.BAT'])('wraps %s shims in cmd.exe /d /s /c', (name) => {
    const command = toSpawnCommand(`C:\\npm\\${name}`, ['exec'], 'win32', {
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    });
    expect(command.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(command.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(command.args[3]).toMatch(/^".*"$/);
    expect(command.windowsVerbatimArguments).toBe(true);
  });

  it('falls back to cmd.exe when ComSpec is unset', () => {
    expect(toSpawnCommand('C:\\npm\\codex.cmd', [], 'win32', {}).file).toBe('cmd.exe');
  });

  it('escapes cmd metacharacters so they are never interpreted', () => {
    const line = toSpawnCommand('C:\\npm\\codex.cmd', ['a&b|c', '%PATH%'], 'win32', {}).args[3];
    expect(line).not.toMatch(/[^^]&/);
    expect(line).not.toMatch(/[^^]%/);
  });
});

// Real round trip: arguments must reach the program unchanged, including through a npm-style
// .cmd shim on Windows, from a folder whose path has spaces and accents.
const trickyArgs = [
  'plain',
  'with space',
  'quote"inside',
  'amp&pipe|chevrons<>',
  'percent%PATH%',
  'caret^bang!',
  'Développement',
  'trailing\\',
  '',
];

describe('argument round trip', () => {
  const echoArgs = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';

  it.skipIf(isWindows)('passes arguments unchanged on POSIX', async () => {
    const dir = join(root, 'Mes Projets', 'Développement');
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'echo-args');
    await writeFile(script, `#!${process.execPath}\n${echoArgs}\n`);
    await chmod(script, 0o755);

    const found = await findExecutable('echo-args', { PATH: dir }, process.platform);
    expect(found).toBe(script);
    const { file, args, windowsVerbatimArguments } = toSpawnCommand(
      script,
      trickyArgs,
      process.platform,
      {},
    );
    const result = spawnSync(file, args, { encoding: 'utf8', windowsVerbatimArguments });
    expect(JSON.parse(result.stdout)).toEqual(trickyArgs);
  });

  it.runIf(isWindows)('passes arguments unchanged through a npm .cmd shim on Windows', async () => {
    const dir = join(root, 'Mes Projets', 'Développement');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'echo-args.js'), echoArgs);
    // Same shape as the shims npm generates in %APPDATA%\npm.
    await writeFile(
      join(dir, 'echo-args.cmd'),
      `@"${process.execPath}" "%~dp0\\echo-args.js" %*\r\n`,
    );

    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const found = await findExecutable('echo-args', env, 'win32');
    expect(found).toBe(join(dir, 'echo-args.cmd'));
    const { file, args, windowsVerbatimArguments } = toSpawnCommand(
      found ?? '',
      trickyArgs,
      'win32',
      process.env,
    );
    const result = spawnSync(file, args, { encoding: 'utf8', windowsVerbatimArguments });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(trickyArgs);
  });
});
