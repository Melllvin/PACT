import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// From Node, the `electron` package exports the path of the Electron binary.
const electronPath = createRequire(import.meta.url)('electron') as string;

// research.md R4: CLIs without HTTP hooks run the built bridge with the Electron binary in Node
// mode, so users need neither Node nor curl. This runs the real build on every CI OS.
test('the built hook bridge relays a payload through Electron in Node mode', async () => {
  const received: { body: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ body, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end('{"decision":"allow"}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const bridge = spawn(electronPath, [resolve('out/main/hook-bridge.js')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PACT_HOOK_URL: url,
        PACT_AGENT_TOKEN: 'a1b2c3',
      },
    });
    let stdout = '';
    bridge.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const exitCode = new Promise<number | null>((done) => bridge.on('exit', done));
    bridge.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: 'C:\\Développement' }));

    expect(await exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ decision: 'allow' });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]?.body ?? '')).toEqual({
      hook_event_name: 'Stop',
      cwd: 'C:\\Développement',
    });
    expect(received[0]?.headers['x-pact-token']).toBe('a1b2c3');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
