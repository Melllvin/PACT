import { describe, expect, it, vi } from 'vitest';
import { handleMcp, type McpTool } from '../../../../src/main/orchestrator/mcp';

// 003 T004 — the four MCP methods PACT serves to its orchestrator (research R1).

const echo: McpTool = {
  name: 'echo',
  description: 'Répète',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  call: vi.fn((args: unknown) =>
    Promise.resolve({ content: [{ type: 'text' as const, text: JSON.stringify(args) }] }),
  ),
};

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

describe('handleMcp', () => {
  it('initializes with the version of the client and the tools capability', async () => {
    expect(await handleMcp(rpc('initialize', { protocolVersion: '2025-11-25' }), [echo])).toEqual({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'pact', version: expect.any(String) as string },
        },
      },
    });
  });

  it('answers ping', async () => {
    expect((await handleMcp(rpc('ping'), [])).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('accepts a notification with 202 and no body', async () => {
    expect(await handleMcp(rpc('notifications/initialized', undefined, null), [])).toEqual({
      status: 202,
    });
  });

  it('lists the tools with their input schema', async () => {
    expect((await handleMcp(rpc('tools/list'), [echo])).body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{ name: 'echo', description: 'Répète', inputSchema: echo.inputSchema }],
      },
    });
  });

  it('calls a tool with its arguments', async () => {
    const reply = await handleMcp(
      rpc('tools/call', { name: 'echo', arguments: { text: 'salut' } }),
      [echo],
    );
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"text":"salut"}' }] },
    });
  });

  it('turns a tool that throws into a result marked as an error, with its message', async () => {
    const broken: McpTool = {
      ...echo,
      name: 'broken',
      call: () => Promise.reject(new Error('Non.')),
    };
    expect((await handleMcp(rpc('tools/call', { name: 'broken' }), [broken])).body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'Non.' }], isError: true },
    });
  });

  it('refuses an unknown tool with -32602', async () => {
    const reply = await handleMcp(rpc('tools/call', { name: 'nope' }), [echo]);
    expect(reply.body).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it('refuses an unknown method, server/discover included, with -32601', async () => {
    for (const method of ['resources/list', 'server/discover']) {
      expect((await handleMcp(rpc(method), [])).body).toMatchObject({
        id: 1,
        error: { code: -32601 },
      });
    }
  });

  it('refuses what is not a JSON-RPC request with -32600', async () => {
    for (const body of [null, 'x', { id: 1 }, { jsonrpc: '1.0', id: 1, method: 'ping' }]) {
      expect(await handleMcp(body, [])).toEqual({
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: expect.any(String) as string },
        },
      });
    }
  });
});
