import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeOrchestratorPlugin } from '../../../../src/main/orchestrator/plugin';

// 003 T006 — the session plugin that brings the skill and the MCP server (research R2).

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-plugin-'));
  dir = join(root, 'Données utilisateur', 'orchestrator', 'agent 1', 'plugin');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = async (path: string) => readFile(join(dir, path), 'utf8');

describe('writeOrchestratorPlugin', () => {
  it('names the plugin pact', async () => {
    await writeOrchestratorPlugin(dir, { url: 'http://127.0.0.1:4567/mcp' });
    expect(JSON.parse(await read('.claude-plugin/plugin.json'))).toMatchObject({ name: 'pact' });
  });

  it('writes the orchestrateur skill with its front matter and its rules', async () => {
    await writeOrchestratorPlugin(dir, { url: 'http://127.0.0.1:4567/mcp' });
    const skill = await read('skills/orchestrateur/SKILL.md');
    expect(skill).toMatch(/^---\nname: orchestrateur\ndescription: .+\n---\n/);
    for (const rule of ['wait_for_agents', 'get_changes', 'request_integration', 'utilisateur']) {
      expect(skill).toContain(rule);
    }
  });

  it('declares the pact MCP server with the token read from the environment', async () => {
    await writeOrchestratorPlugin(dir, { url: 'http://127.0.0.1:4567/mcp' });
    expect(JSON.parse(await read('.mcp.json'))).toEqual({
      mcpServers: {
        pact: {
          type: 'http',
          url: 'http://127.0.0.1:4567/mcp',
          headers: { 'X-Pact-Token': '${PACT_ORCHESTRATOR_TOKEN}' },
        },
      },
    });
  });

  it('writes the URL of the moment again on the next start', async () => {
    await writeOrchestratorPlugin(dir, { url: 'http://127.0.0.1:4567/mcp' });
    await writeOrchestratorPlugin(dir, { url: 'http://127.0.0.1:5678/mcp' });
    expect(await read('.mcp.json')).toContain('5678');
  });
});
