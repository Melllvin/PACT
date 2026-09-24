import { connect, createServer } from 'node:net';

// research.md R8 / FR-015 — port = 3000 + position, else the first free port beyond 3006.

const LOOPBACKS = ['127.0.0.1', '::1'] as const;
const PORTS_PER_WORKSPACE = 6;
const CONNECT_TIMEOUT_MS = 300;

const acceptsConnections = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });

const bindFails = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      // An address family missing on this machine (no IPv6) says nothing about the port.
      resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES');
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve(false);
      });
    });
  });

/**
 * A listener on 0.0.0.0 does not always make a 127.0.0.1 bind fail (SO_REUSEADDR on macOS), so a
 * port also counts as used when something answers on a loopback address.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  for (const host of LOOPBACKS) {
    if ((await bindFails(port, host)) || (await acceptsConnections(port, host))) return true;
  }
  return false;
}

type AllocateOptions = { base?: number; maxPort?: number };

export async function allocatePort(
  position: number,
  used: ReadonlySet<number>,
  { base = 3000, maxPort = 65535 }: AllocateOptions = {},
): Promise<number> {
  const preferred = base + position;
  if (!used.has(preferred) && !(await isPortInUse(preferred))) return preferred;
  for (let port = base + PORTS_PER_WORKSPACE + 1; port <= maxPort; port++) {
    if (!used.has(port) && !(await isPortInUse(port))) return port;
  }
  throw new Error(`Aucun port libre entre ${String(base + 1)} et ${String(maxPort)}`);
}
