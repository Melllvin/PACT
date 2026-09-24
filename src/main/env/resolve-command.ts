import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

// research.md R3 — locate CLIs in the resolved PATH and launch Windows shims through cmd.exe.

type Env = Record<string, string | undefined>;

/** Windows environment keys are case-insensitive (`Path`, `PATH`, `PathExt`…). */
const readVar = (env: Env, name: string, platform: NodeJS.Platform) => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

async function isExecutableFile(path: string, platform: NodeJS.Platform) {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Full path of `command` looked up in PATH (with PATHEXT on Windows), or null. */
export async function findExecutable(
  command: string,
  env: Env,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const windows = platform === 'win32';
  const extensions = windows
    ? ['', ...(readVar(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  const candidates = (base: string) =>
    windows && extname(base) === ''
      ? extensions.filter(Boolean).map((ext) => base + ext.toLowerCase())
      : [base];

  if (isAbsolute(command) || /[\\/]/.test(command)) {
    for (const candidate of candidates(command)) {
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  }

  const dirs = (readVar(env, 'PATH', platform) ?? '').split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates(join(dir, command))) {
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export type SpawnCommand = { file: string; args: string[]; windowsVerbatimArguments: boolean };

// Escaping rules for cmd.exe, as established by cross-spawn: quote with the MSVC rules, then
// caret-escape every metacharacter. npm shims re-parse %* once more, hence the second pass.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

const escapeCmdCommand = (path: string) => path.replace(CMD_META, '^$1');

function escapeCmdArgument(arg: string, doubleEscape: boolean) {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META, '^$1');
  return doubleEscape ? escaped.replace(CMD_META, '^$1') : escaped;
}

/** How to spawn `executable` with `args`: directly, or through cmd.exe for .cmd/.bat shims. */
export function toSpawnCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
  env: Env,
): SpawnCommand {
  const extension = extname(executable).toLowerCase();
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { file: executable, args, windowsVerbatimArguments: false };
  }
  const doubleEscape = extension === '.cmd';
  const line = [
    escapeCmdCommand(executable),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(' ');
  return {
    file: readVar(env, 'COMSPEC', platform) ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
