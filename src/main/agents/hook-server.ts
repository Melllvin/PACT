import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
export class HookServer {
  private server?: Server;
  private handlers = new Map<string, (payload: unknown) => unknown>();
  url = '';
  register(agentId: string, handler: (payload: unknown) => unknown) {
    const token = randomBytes(24).toString('hex');
    this.handlers.set(token, handler);
    return token;
  }
  async start() {
    this.server = createServer((req, res) => {
      const handler = this.handlers.get(String(req.headers['x-pact-token']));
      if (req.method !== 'POST' || !handler) {
        res.writeHead(401).end();
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        try {
          const result = handler(JSON.parse(raw));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result ?? {}));
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    return this.url;
  }
  async stop() {
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((e) => (e ? reject(e) : resolve())),
      );
  }
}
