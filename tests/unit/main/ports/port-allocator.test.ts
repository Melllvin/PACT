import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { allocatePort, isPortInUse } from '../../../../src/main/ports/port-allocator';

// A random high base keeps the tests away from ports used by other programs on the machine.
const base = 20000 + Math.floor(Math.random() * 20000);
const servers: Server[] = [];

const occupy = (port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      servers.push(server);
      resolve();
    });
  });

const ipv6Available = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => {
    resolve(false);
  });
  server.listen(0, '::1', () =>
    server.close(() => {
      resolve(true);
    }),
  );
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('allocatePort', () => {
  it('gives position N the port base + N', async () => {
    expect(await allocatePort(1, new Set(), { base })).toBe(base + 1);
    expect(await allocatePort(6, new Set(), { base })).toBe(base + 6);
  });

  it('defaults to 3000 + position', async () => {
    const port = await allocatePort(3, new Set());
    expect(port === 3003 || port > 3006).toBe(true);
  });

  it('moves to the first free port beyond base + 6 when the port is taken on 127.0.0.1', async () => {
    await occupy(base + 2, '127.0.0.1');
    expect(await allocatePort(2, new Set(), { base })).toBe(base + 7);
  });

  it.runIf(ipv6Available)('detects a port taken on ::1', async () => {
    await occupy(base + 3, '::1');
    expect(await allocatePort(3, new Set(), { base })).toBe(base + 7);
  });

  it('detects a port taken on every interface (0.0.0.0)', async () => {
    await occupy(base + 4, '0.0.0.0');
    expect(await allocatePort(4, new Set(), { base })).toBe(base + 7);
  });

  it('skips busy ports while searching', async () => {
    await occupy(base + 1, '127.0.0.1');
    await occupy(base + 7, '127.0.0.1');
    expect(await allocatePort(1, new Set(), { base })).toBe(base + 8);
  });

  it('never returns a port already given to another agent of the workspace', async () => {
    expect(await allocatePort(1, new Set([base + 1]), { base })).toBe(base + 7);
    expect(await allocatePort(1, new Set([base + 1, base + 7]), { base })).toBe(base + 8);
  });

  it('fails instead of looping forever when no port is left', async () => {
    const used = new Set([base + 1, base + 7, base + 8]);
    await expect(allocatePort(1, used, { base, maxPort: base + 8 })).rejects.toThrow();
  });
});

describe('isPortInUse', () => {
  it('is false for a free port and true once a server listens', async () => {
    expect(await isPortInUse(base + 5)).toBe(false);
    await occupy(base + 5, '127.0.0.1');
    expect(await isPortInUse(base + 5)).toBe(true);
  });
});
