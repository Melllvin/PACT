import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayHook, userStatusLine } from '../../../src/main/agents/hook-bridge';
import { HookServer } from '../../../src/main/agents/hook-server';

// 005 T008 — `/statusline` of the hook server and the bridge's `--statusline` (R1).

let server: HookServer;
let url: string;
let home: string;

beforeEach(async () => {
  server = new HookServer();
  url = await server.start();
  home = await mkdtemp(join(tmpdir(), 'pact-statusline-'));
});

afterEach(async () => {
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

const post = (token: string, body: string) =>
  fetch(`${url}/statusline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pact-token': token },
    body,
  });

const collect = () => {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
};

const PAYLOAD = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 62 } } });
/** As Claude Code sends it, from a project without settings of its own. */
const payload = () => JSON.stringify({ cwd: home, ...(JSON.parse(PAYLOAD) as object) });

describe('/statusline', () => {
  it('answers one line of text with the agent’s token', async () => {
    const statusLine = vi.fn(() => 'PACT · 5 h 62 %\nsecond');
    const token = server.register('agent-1', vi.fn(), statusLine);
    const response = await post(token, PAYLOAD);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('PACT · 5 h 62 % second');
    expect(statusLine).toHaveBeenCalledWith(JSON.parse(PAYLOAD));
  });

  it('refuses an unknown token with an empty body, and a token revoked', async () => {
    const token = server.register('agent-1', vi.fn(), () => 'x');
    const unknown = await post('0'.repeat(64), PAYLOAD);
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toBe('');
    server.unregister('agent-1');
    expect((await post(token, PAYLOAD)).status).toBe(401);
  });

  it('answers « PACT » for an agent without a usage source, and refuses what is not JSON', async () => {
    const token = server.register('agent-1', vi.fn());
    expect(await (await post(token, PAYLOAD)).text()).toBe('PACT');
    expect((await post(token, '{coupé')).status).toBe(400);
    const get = await fetch(`${url}/statusline`, { headers: { 'x-pact-token': token } });
    expect(get.status).toBe(405);
  });

  it('keeps « PACT » when the handler fails', async () => {
    const token = server.register('agent-1', vi.fn(), () => {
      throw new Error('boom');
    });
    expect(await (await post(token, PAYLOAD)).text()).toBe('PACT');
  });
});

describe('hook-bridge --statusline', () => {
  it('posts the payload and prints PACT’s line', async () => {
    const statusLine = vi.fn(() => 'PACT · 5 h 62 %');
    const token = server.register('agent-1', vi.fn(), statusLine);
    const out = collect();
    await relayHook({
      stdin: Readable.from([payload()]),
      stdout: out.stream,
      env: { PACT_HOOK_URL: url, PACT_AGENT_TOKEN: token, HOME: home, CLAUDE_CONFIG_DIR: '' },
      argv: ['--statusline'],
    });
    expect(out.text()).toBe('PACT · 5 h 62 %');
    expect(statusLine).toHaveBeenCalledTimes(1);
  });

  it('runs the user’s own statusLine with the same payload, PACT still told', async () => {
    const statusLine = vi.fn(() => 'PACT');
    const token = server.register('agent-1', vi.fn(), statusLine);
    const claude = join(home, '.claude');
    await mkdir(claude);
    const script = join(home, 'ligne.mjs');
    await writeFile(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(home, 'reçu.json'))}, readFileSync(0, 'utf8'));
process.stdout.write('ma ligne');`,
    );
    const settings = JSON.stringify({
      statusLine: { type: 'command', command: `"${process.execPath}" "${script}"` },
    });
    await writeFile(join(claude, 'settings.json'), settings);
    const out = collect();
    await relayHook({
      stdin: Readable.from([payload()]),
      stdout: out.stream,
      env: {
        ...process.env,
        PACT_HOOK_URL: url,
        PACT_AGENT_TOKEN: token,
        HOME: home,
        CLAUDE_CONFIG_DIR: '',
      },
      argv: ['--statusline'],
    });
    expect(out.text()).toBe('ma ligne');
    expect(await readFile(join(home, 'reçu.json'), 'utf8')).toBe(payload());
    expect(statusLine).toHaveBeenCalledTimes(1);
    // Read only: the user's settings are as they were.
    expect(await readFile(join(claude, 'settings.json'), 'utf8')).toBe(settings);
  });

  it('prints nothing when PACT is gone and there is no statusLine of the user', async () => {
    const out = collect();
    await relayHook({
      stdin: Readable.from([payload()]),
      stdout: out.stream,
      env: { PACT_HOOK_URL: 'http://127.0.0.1:9', HOME: home },
      argv: ['--statusline'],
    });
    expect(out.text()).toBe('');
  });

  it('prints nothing when PACT refuses the token, or without its address', async () => {
    server.register('agent-1', vi.fn(), () => 'PACT · 5 h 62 %');
    // No token, and a payload without a cwd as text: the user's settings are looked up from here.
    for (const env of [{ PACT_HOOK_URL: url, HOME: home }, { HOME: home }]) {
      const out = collect();
      await relayHook({
        stdin: Readable.from([JSON.stringify({ cwd: 3 })]),
        stdout: out.stream,
        env,
        argv: ['--statusline'],
      });
      expect(out.text()).toBe('');
    }
  });
});

describe('userStatusLine', () => {
  it('takes the project’s over the user’s, and ignores what is not a command', async () => {
    const config = join(home, 'config');
    const project = join(home, 'projet');
    await mkdir(join(project, '.claude'), { recursive: true });
    await mkdir(config);
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'a' } }),
    );
    expect(await userStatusLine({ CLAUDE_CONFIG_DIR: config }, project)).toBe('a');
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'b' } }),
    );
    expect(await userStatusLine({ CLAUDE_CONFIG_DIR: config }, project)).toBe('b');
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'static', command: 'c' } }),
    );
    await writeFile(join(project, '.claude', 'settings.json'), '{coupé');
    expect(await userStatusLine({ CLAUDE_CONFIG_DIR: config }, project)).toBe('a');
    expect(await userStatusLine({ HOME: join(home, 'vide') }, join(home, 'vide'))).toBeNull();
  });
});
