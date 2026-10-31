import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookServer } from '../../../src/main/agents/hook-server';

let server: HookServer;
let url: string;

beforeEach(async () => {
  server = new HookServer();
  url = await server.start();
});

afterEach(async () => {
  await server.stop();
});

const post = (token: string | undefined, body: string, target = url) =>
  fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-pact-token': token } : {}) },
    body,
  });

describe('HookServer', () => {
  it('listens on 127.0.0.1 on a random port', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).not.toBe('http://127.0.0.1:0');
  });

  it('rejects requests without a valid token and never calls a handler', async () => {
    const handler = vi.fn();
    server.register('agent-1', handler);
    expect((await post(undefined, '{}')).status).toBe(401);
    expect((await post('forged', '{}')).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('routes each payload to the agent owning the token', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const token1 = server.register('agent-1', first);
    const token2 = server.register('agent-2', second);
    expect(token1).not.toBe(token2);
    expect(token1).toMatch(/^[a-f0-9]{64}$/);

    await post(token2, JSON.stringify({ type: 'turn-finished' }));
    expect(second).toHaveBeenCalledWith({ type: 'turn-finished' });
    expect(first).not.toHaveBeenCalled();
  });

  it('accepts the token as a path segment for CLIs that cannot set headers', async () => {
    const handler = vi.fn();
    const token = server.register('agent-1', handler);
    expect((await post(undefined, '{"a":1}', `${url}/t/${token}`)).status).toBe(200);
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it('waits for an asynchronous decision and returns it (PermissionRequest)', async () => {
    let decide: (value: unknown) => void = () => undefined;
    const token = server.register(
      'agent-1',
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    const response = post(token, JSON.stringify({ hook_event_name: 'PermissionRequest' }));
    await new Promise((r) => setTimeout(r, 50));
    decide({ decision: { behavior: 'allow' } });
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: { behavior: 'allow' } });
  });

  it('answers {} when the handler returns nothing', async () => {
    const token = server.register('agent-1', () => undefined);
    expect(await (await post(token, '{}')).json()).toEqual({});
  });

  it('rejects other methods, invalid JSON and oversized bodies', async () => {
    const handler = vi.fn();
    const token = server.register('agent-1', handler);
    expect((await fetch(url, { headers: { 'x-pact-token': token } })).status).toBe(405);
    expect((await post(token, '{not json')).status).toBe(400);
    expect((await post(token, JSON.stringify({ big: 'x'.repeat(1_100_000) }))).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps serving after a handler throws', async () => {
    const token = server.register('agent-1', () => {
      throw new Error('boom');
    });
    expect((await post(token, '{}')).status).toBe(500);
    const other = server.register('agent-2', () => ({ ok: true }));
    expect(await (await post(other, '{}')).json()).toEqual({ ok: true });
  });

  it('revokes a token when the agent is unregistered', async () => {
    const token = server.register('agent-1', () => ({}));
    server.unregister('agent-1');
    expect((await post(token, '{}')).status).toBe(401);
  });

  it('issues a new token when an agent registers again', async () => {
    const old = server.register('agent-1', () => ({}));
    const fresh = server.register('agent-1', () => ({}));
    expect((await post(old, '{}')).status).toBe(401);
    expect((await post(fresh, '{}')).status).toBe(200);
  });

  it('stops cleanly, even when stopped twice', async () => {
    await server.stop();
    await server.stop();
    await expect(post('x', '{}')).rejects.toThrow();
  });
});

/** A raw request, since fetch never lets a test choose Host. */
const raw = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(url);
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });

describe('HookServer, the orchestrator MCP route (003 T005)', () => {
  const mcp = () =>
    vi.fn((payload: unknown) =>
      Promise.resolve(
        (payload as { id?: number }).id === undefined
          ? { status: 202 }
          : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } },
      ),
    );

  it('gives POST /mcp to the handler of the token, which chooses the status', async () => {
    const handler = mcp();
    const token = server.registerMcp('agent-1', handler);
    const reply = await raw(
      'POST',
      '/mcp',
      { 'x-pact-token': token },
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    );
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(handler).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const notified = await raw(
      'POST',
      '/mcp',
      { 'x-pact-token': token },
      '{"jsonrpc":"2.0","method":"x"}',
    );
    expect(notified).toEqual({ status: 202, body: '' });
  });

  it('answers GET /mcp with 405: no stream from the server', async () => {
    const token = server.registerMcp('agent-1', mcp());
    expect((await raw('GET', '/mcp', { 'x-pact-token': token })).status).toBe(405);
  });

  it('refuses no token, a hook token, or a revoked one with 401', async () => {
    const handler = mcp();
    const token = server.registerMcp('agent-1', handler);
    const hookToken = server.register('agent-1', vi.fn());
    expect((await raw('POST', '/mcp', {}, '{}')).status).toBe(401);
    expect((await raw('POST', '/mcp', { 'x-pact-token': hookToken }, '{}')).status).toBe(401);
    server.revokeMcp('agent-1');
    expect((await raw('POST', '/mcp', { 'x-pact-token': token }, '{}')).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never lets an MCP token post hooks', async () => {
    const hook = vi.fn();
    server.register('agent-1', hook);
    const token = server.registerMcp('agent-1', mcp());
    expect((await post(token, '{}')).status).toBe(401);
    expect(hook).not.toHaveBeenCalled();
  });

  it('refuses a Host other than its own and any Origin with 403, as a browser would send', async () => {
    const handler = mcp();
    const token = server.registerMcp('agent-1', handler);
    expect(
      (await raw('POST', '/mcp', { 'x-pact-token': token, host: 'evil.example:80' }, '{}')).status,
    ).toBe(403);
    expect(
      (await raw('POST', '/mcp', { 'x-pact-token': token, origin: 'http://evil.example' }, '{}'))
        .status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives the URL of the route', () => {
    expect(server.mcpUrl()).toBe(`${url}/mcp`);
  });
});
