import { type ChildProcess, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestRun } from '../../shared/review';
import { toPlainText } from '../agents/terminal-text';

// 002 R8 — the tests of an agent, run in its worktree through the login shell, outside any PTY.

export const TEST_TIMEOUT_MS = 10 * 60_000;
export const TAIL_LINES = 200;

const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const LOCKFILES: [file: string, command: string][] = [
  ['pnpm-lock.yaml', 'pnpm test'],
  ['yarn.lock', 'yarn test'],
];

/** `npm test`, `pnpm test` or `yarn test` when package.json has a real test script. */
export function detectTestCommand(packageJson: string | null, lockfiles: string[]): string | null {
  if (packageJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { scripts } = parsed as { scripts?: Record<string, unknown> };
  const test = scripts?.test;
  if (typeof test !== 'string' || test.trim() === '' || test.trim() === NPM_PLACEHOLDER) {
    return null;
  }
  return LOCKFILES.find(([file]) => lockfiles.includes(file))?.[1] ?? 'npm test';
}

/** The test command detected in a folder, from its package.json and lockfile. */
export async function detectTestCommandIn(cwd: string): Promise<string | null> {
  const packageJson = await readFile(join(cwd, 'package.json'), 'utf8').catch(() => null);
  const present = await Promise.all(
    LOCKFILES.map(([file]) =>
      access(join(cwd, file)).then(
        () => file,
        () => null,
      ),
    ),
  );
  return detectTestCommand(
    packageJson,
    present.filter((file) => file !== null),
  );
}

/** The number of tests passed, read from the summaries of Vitest/Jest, pytest and cargo. */
export function passedCount(output: string): number | null {
  const text = toPlainText(output);
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed/gm)];
  if (cargo.length > 0) return cargo.reduce((sum, [, n]) => sum + Number(n), 0);
  const summary =
    /^\s*Tests:?\s+(?:[^\n]*?\D)?(\d+) passed/m.exec(text) ??
    /^=+ (?:[^\n]*?\D)?(\d+) passed[^\n]* in [\d.]+s/m.exec(text);
  return summary ? Number(summary[1]) : null;
}

/** The last `count` lines of `text`, its final newline kept. */
export function tail(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.slice(-(text.endsWith('\n') ? count + 1 : count)).join('\n');
}

export type TestTarget = { agentId: string; cwd: string; port: number | null };

type Active = { run: TestRun; child: ChildProcess | null; timer: NodeJS.Timeout; output: string };

type Options = {
  env: () => Promise<Record<string, string>>;
  onUpdate: (run: TestRun) => void;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

export class TestRunner {
  private readonly active = new Map<string, Active>();
  private readonly results = new Map<string, TestRun>();
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: Options) {
    this.timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
  }

  /** Runs the tests, or gives the run in progress: one at a time per agent. */
  async run(target: TestTarget, command: string, tree: string): Promise<TestRun> {
    const current = this.active.get(target.agentId);
    if (current) return { ...current.run };
    const run: TestRun = {
      agentId: target.agentId,
      command,
      tree,
      status: 'running',
      passedCount: null,
      outputTail: '',
    };
    const active: Active = {
      run,
      child: null,
      output: '',
      timer: setTimeout(() => {
        this.finish(active, 'timeout');
      }, this.timeoutMs),
    };
    this.active.set(target.agentId, active);
    this.options.onUpdate({ ...run });
    const env = await this.options.env();
    if (this.active.get(target.agentId) !== active) return { ...run };
    this.start(active, target, env);
    return { ...run };
  }

  /** Runs the tests unless a result, or a run, is for the tree shown, then announced again. */
  async ensure(target: TestTarget, command: string, tree: string): Promise<TestRun | undefined> {
    const latest = this.latest(target.agentId);
    if (latest?.tree !== tree) return this.run(target, command, tree);
    // A window opened since may have missed it.
    this.options.onUpdate(latest);
    return undefined;
  }

  cancel(agentId: string): void {
    const active = this.active.get(agentId);
    if (active) this.finish(active, 'cancelled');
  }

  /** The run in progress, else the last result. */
  latest(agentId: string): TestRun | null {
    const run = this.active.get(agentId)?.run ?? this.results.get(agentId);
    return run ? { ...run } : null;
  }

  dispose(): void {
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      this.kill(active.child);
    }
    this.active.clear();
  }

  private start(active: Active, target: TestTarget, env: Record<string, string>) {
    const windows = this.platform === 'win32';
    const { command } = active.run;
    const child = spawn(
      windows ? (env.ComSpec ?? env.COMSPEC ?? 'cmd.exe') : '/bin/sh',
      windows ? ['/d', '/s', '/c', `"${command}"`] : ['-lc', command],
      {
        cwd: target.cwd,
        env: target.port === null ? env : { ...env, PORT: String(target.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a cancel reaches what the command started.
        detached: !windows,
        windowsHide: true,
        windowsVerbatimArguments: windows,
      },
    );
    active.child = child;
    const read = (chunk: string) => {
      active.output = tail(active.output + chunk, TAIL_LINES);
    };
    // Decoded per stream, so a character split across two chunks stays whole.
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', read);
    child.on('error', (error) => {
      active.output = tail(`${active.output}${error.message}\n`, TAIL_LINES);
      this.finish(active, 'failed');
    });
    child.on('close', (code) => {
      this.finish(active, code === 0 ? 'passed' : 'failed');
    });
  }

  private finish(active: Active, status: Exclude<TestRun['status'], 'running'>) {
    const { agentId } = active.run;
    if (this.active.get(agentId) !== active) return;
    this.active.delete(agentId);
    clearTimeout(active.timer);
    if (status === 'cancelled' || status === 'timeout') this.kill(active.child);
    const run: TestRun = {
      ...active.run,
      status,
      passedCount: passedCount(active.output),
      outputTail: active.output,
    };
    this.results.set(agentId, run);
    this.options.onUpdate({ ...run });
  }

  private kill(child: ChildProcess | null) {
    if (child?.pid === undefined || child.exitCode !== null) return;
    if (this.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => undefined,
      );
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
