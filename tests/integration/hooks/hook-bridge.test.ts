import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayHook } from '../../../src/main/agents/hook-bridge';
import { HookServer } from '../../../src/main/agents/hook-server';

// The bridge is the hook command of CLIs without HTTP hooks: stdin JSON → PACT → stdout.
let server: HookServer;
let url: string;

beforeEach(async () => {
  server = new HookServer();
  url = await server.start();
});

afterEach(async () => {
  await server.stop();
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

describe('relayHook', () => {
  it('posts the hook payload read from stdin and prints PACT’s answer', async () => {
    const handler = vi.fn(() => ({ decision: 'approve' }));
    const token = server.register('agent-1', handler);
    const out = collect();

    await relayHook({
      stdin: Readable.from([JSON.stringify({ hook_event_name: 'Stop' })]),
      stdout: out.stream,
      env: { PACT_HOOK_URL: url, PACT_AGENT_TOKEN: token },
    });

    expect(handler).toHaveBeenCalledWith({ hook_event_name: 'Stop' });
    expect(JSON.parse(out.text())).toEqual({ decision: 'approve' });
  });

  it('relays a Codex notify payload given as the last argument, without reading stdin', async () => {
    const handler = vi.fn(() => ({}));
    const token = server.register('agent-1', handler);
    const notify = { type: 'agent-turn-complete', 'thread-id': 't1' };
    const stdin = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
    };

    await relayHook({
      stdin,
      stdout: collect().stream,
      env: { PACT_HOOK_URL: url, PACT_AGENT_TOKEN: token },
      argv: ['--notify', JSON.stringify(notify)],
    });

    expect(handler).toHaveBeenCalledWith(notify);
  });

  it('does nothing outside of PACT (no hook URL)', async () => {
    const out = collect();
    await relayHook({ stdin: Readable.from(['{}']), stdout: out.stream, env: {} });
    expect(out.text()).toBe('');
  });

  it('never fails the CLI when PACT is unreachable or rejects the call', async () => {
    const out = collect();
    await server.stop();
    await expect(
      relayHook({
        stdin: Readable.from(['{}']),
        stdout: out.stream,
        env: { PACT_HOOK_URL: url, PACT_AGENT_TOKEN: 'x' },
      }),
    ).resolves.toBeUndefined();
    expect(out.text()).toBe('');
  });

  it('prints nothing when the token is refused', async () => {
    const out = collect();
    await relayHook({
      stdin: Readable.from(['{}']),
      stdout: out.stream,
      env: { PACT_HOOK_URL: url, PACT_AGENT_TOKEN: 'forged' },
    });
    expect(out.text()).toBe('');
  });
});
