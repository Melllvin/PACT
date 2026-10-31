import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// research.md R4 — local HTTP relay for agent hooks, bound to 127.0.0.1, one secret token per agent.

const MAX_BODY_BYTES = 1_000_000;
const TOKEN_PATH = /^\/t\/([a-f0-9]{64})\/?$/;

/** May answer asynchronously: a PermissionRequest decision waits for the user. */
export type HookHandler = (payload: unknown) => unknown;

/** 003 — the orchestrator's MCP requests: the handler chooses the status (202 for notices). */
export type McpHandler = (payload: unknown) => Promise<{ status: number; body?: unknown }>;

const MCP_PATH = '/mcp';

export class HookServer {
  private server: Server | undefined;
  private address: string | undefined;
  private readonly handlers = new Map<string, HookHandler>();
  private readonly tokens = new Map<string, string>();
  /** Orchestrator tokens, kept apart: a hook token never reaches /mcp, nor the reverse. */
  private readonly mcpHandlers = new Map<string, McpHandler>();
  private readonly mcpTokens = new Map<string, string>();

  /** Registers (or re-registers) an agent and returns its new token; any old token is revoked. */
  register(agentId: string, handler: HookHandler): string {
    this.unregister(agentId);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(agentId, token);
    this.handlers.set(token, handler);
    return token;
  }

  unregister(agentId: string): void {
    const token = this.tokens.get(agentId);
    if (token) this.handlers.delete(token);
    this.tokens.delete(agentId);
  }

  /** Registers (or re-registers) the orchestrator `agentId` and returns its new token. */
  registerMcp(agentId: string, handler: McpHandler): string {
    this.revokeMcp(agentId);
    const token = randomBytes(32).toString('hex');
    this.mcpTokens.set(agentId, token);
    this.mcpHandlers.set(token, handler);
    return token;
  }

  revokeMcp(agentId: string): void {
    const token = this.mcpTokens.get(agentId);
    if (token) this.mcpHandlers.delete(token);
    this.mcpTokens.delete(agentId);
  }

  /** Where the orchestrators reach PACT, once started. */
  mcpUrl(): string {
    if (!this.address) throw new Error('Hook server not started');
    return `${this.address}${MCP_PATH}`;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const answer = req.url === MCP_PATH ? this.respondMcp(req) : this.respond(req);
      void answer.then(({ status, body }) => {
        reply(res, status, body);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Hook server has no port');
    this.address = `http://127.0.0.1:${String(address.port)}`;
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }

  /**
   * 003 R3 — besides the token, a request must name this server as its Host and come from no web
   * page (no Origin): a browser cannot reach the orchestrator's tools.
   */
  private async respondMcp(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    if (req.headers.origin !== undefined || `http://${req.headers.host ?? ''}` !== this.address) {
      return { status: 403 };
    }
    const token = req.headers['x-pact-token'];
    const handler = typeof token === 'string' ? this.mcpHandlers.get(token) : undefined;
    if (!handler) return { status: 401 };
    if (req.method !== 'POST') return { status: 405 };
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      return { status: error instanceof BodyTooLarge ? 413 : 400 };
    }
    try {
      return await handler(payload);
    } catch {
      return { status: 500 };
    }
  }

  private async respond(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const token = req.headers['x-pact-token'] ?? TOKEN_PATH.exec(req.url ?? '')?.[1];
    const handler = typeof token === 'string' ? this.handlers.get(token) : undefined;
    if (!handler) return { status: 401 };
    if (req.method !== 'POST') return { status: 405 };

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      return { status: error instanceof BodyTooLarge ? 413 : 400 };
    }
    try {
      return { status: 200, body: (await handler(payload)) ?? {} };
    } catch {
      return { status: 500 };
    }
  }
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
