import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginSkill, SKILL_NAME, writePactPlugin } from '../../../../src/main/orchestrator/plugin';

// 003 T006, 004 T045 — the session plugin that brings the MCP server (research R2, R3).

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-plugin-'));
  dir = join(root, 'Données utilisateur', 'roles', 'agent 1', 'plugin');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = async (path: string) => readFile(join(dir, path), 'utf8');
const write = (url: string, tokenVariable = 'PACT_ORCHESTRATOR_TOKEN') =>
  writePactPlugin(dir, { url, tokenVariable });

describe('writePactPlugin', () => {
  it('names the plugin pact, its skills pact:<name>', async () => {
    await write('http://127.0.0.1:4567/mcp');
    expect(JSON.parse(await read('.claude-plugin/plugin.json'))).toMatchObject({ name: 'pact' });
    expect(pluginSkill('pact-dev')).toBe('pact:pact-dev');
    expect(SKILL_NAME).toBe('pact:pact-orchestrator');
  });

  it('declares the pact MCP server with the token read from the environment', async () => {
    await write('http://127.0.0.1:4567/mcp', 'PACT_AGENT_MCP_TOKEN');
    expect(JSON.parse(await read('.mcp.json'))).toEqual({
      mcpServers: {
        pact: {
          type: 'http',
          url: 'http://127.0.0.1:4567/mcp',
          headers: { 'X-Pact-Token': '${PACT_AGENT_MCP_TOKEN}' },
        },
      },
    });
  });

  it('writes the URL of the moment again on the next start', async () => {
    await write('http://127.0.0.1:4567/mcp');
    await write('http://127.0.0.1:5678/mcp');
    expect(await read('.mcp.json')).toContain('5678');
  });
});
