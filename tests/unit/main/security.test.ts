import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';

// T114 — security review; `specs/001-agent-workspace-core/security-review.md` records each point.

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });

const csp = () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  return new Map(
    content
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name = '', ...values]) => [name, values]),
  );
};

describe('renderer Content-Security-Policy', () => {
  it('runs only PACT’s own scripts: no inline script, no eval', () => {
    expect(csp().get('default-src')).toEqual(["'self'"]);
    expect(csp().get('script-src')).toEqual(["'self'"]);
  });

  it('forbids plugins, a moved base URL and form posts', () => {
    expect(csp().get('object-src')).toEqual(["'none'"]);
    expect(csp().get('base-uri')).toEqual(["'none'"]);
    expect(csp().get('form-action')).toEqual(["'none'"]);
  });
});

describe('main and preload processes', () => {
  const code = [...sources('src/main'), ...sources('src/preload')].map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));

  it('never log, so a hook token can never end up in a log', () => {
    expect(code.filter(({ text }) => /\bconsole\.\w+\(/.test(text)).map((c) => c.path)).toEqual([]);
  });

  it('never run a command through a shell: arguments go as a list', () => {
    const shelled = code.filter(({ text }) =>
      /(?<![.\w])exec(Sync)?\(|shell:\s*true|\bexec(Sync)?\b[^;]*from 'node:child_process'/.test(
        text,
      ),
    );
    expect(shelled.map((c) => c.path)).toEqual([]);
  });
});

describe('hook server', () => {
  it('listens on the loopback only', async () => {
    const hooks = new HookServer();
    const url = await hooks.start();
    expect(new URL(url).hostname).toBe('127.0.0.1');
    await hooks.stop();
  });
});

describe('git clone', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the ext:: transport even when the user’s git config allows every protocol', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pact-sec-'));
    const marker = join(dir, 'ran');
    const git = new GitService({
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.allow',
        GIT_CONFIG_VALUE_0: 'always',
      },
    });
    await expect(
      git.clone(`ext::sh -c touch% ${marker}`, join(dir, 'clone'), () => undefined),
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});
