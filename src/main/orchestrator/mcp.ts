// 003 research R1 — the part of MCP that PACT serves to its orchestrator: JSON-RPC 2.0 over
// POST, with initialize, ping, tools/list and tools/call. Pure: the transport is HookServer's.

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type McpTool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as `tools/list` gives it. */
  inputSchema: Record<string, unknown>;
  call: (args: unknown) => Promise<ToolResult>;
};

export type McpReply = { status: number; body?: unknown };

const VERSION = '1';
const DEFAULT_PROTOCOL = '2025-06-18';

type Request = { id?: string | number | null; method: string; params?: unknown };

const isRequest = (value: unknown): value is Request & { jsonrpc: '2.0' } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
  typeof (value as { method?: unknown }).method === 'string';

const result = (id: Request['id'], value: unknown): McpReply => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result: value },
});

const failure = (id: Request['id'], code: number, message: string): McpReply => ({
  status: 200,
  body: { jsonrpc: '2.0', id, error: { code, message } },
});

const param = (params: unknown, key: string): unknown =>
  typeof params === 'object' && params !== null
    ? (params as Record<string, unknown>)[key]
    : undefined;

export async function handleMcp(body: unknown, tools: readonly McpTool[]): Promise<McpReply> {
  if (!isRequest(body)) return failure(null, -32600, 'Requête JSON-RPC 2.0 attendue');
  const { id, method, params } = body;
  // A notification gets no answer (MCP streamable HTTP).
  if (id === undefined) return { status: 202 };
  switch (method) {
    case 'initialize': {
      const asked = param(params, 'protocolVersion');
      return result(id, {
        protocolVersion: typeof asked === 'string' ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'pact', version: VERSION },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === param(params, 'name'));
      if (!tool) return failure(id, -32602, `Outil inconnu : ${String(param(params, 'name'))}`);
      try {
        return result(id, await tool.call(param(params, 'arguments') ?? {}));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return result(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Méthode inconnue : ${method}`);
  }
}
