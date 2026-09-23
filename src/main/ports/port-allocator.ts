import { createServer } from 'node:net';
const available = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
export async function allocatePort(position: number, used: ReadonlySet<number> = new Set()) {
  let port = 3000 + position;
  while (used.has(port) || !(await available(port))) port = Math.max(port + 1, 3007);
  return port;
}
