import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let cached: NodeJS.ProcessEnv | undefined;
export async function resolveShellEnv(platform = process.platform): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached;
  if (platform === 'win32') return (cached = { ...process.env });
  try {
    const { stdout } = await exec(process.env.SHELL || '/bin/sh', ['-ilc', 'env'], {
      timeout: 3000,
    });
    cached = {
      ...process.env,
      ...Object.fromEntries(
        stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      ),
    };
  } catch {
    cached = { ...process.env };
  }
  return cached;
}
export function clearShellEnvCache() {
  cached = undefined;
}
