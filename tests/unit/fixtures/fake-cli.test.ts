import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

type Hook = { body: Record<string, unknown>; headers: IncomingHttpHeaders };

let server: Server | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let tmp: string | undefined;

afterEach(async () => {
  // Wait for the process to be gone: Windows keeps its working directory locked until then.
  const running = child;
  if (running && running.exitCode === null && running.signalCode === null) {
    const exited = new Promise((resolve) => running.once('exit', resolve));
    running.kill();
    await exited;
  }
  await new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve(undefined);
  });
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  server = child = tmp = undefined;
});

async function startHookServer(hooks: Hook[]) {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      hooks.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
}

async function runFake(
  scenario: string,
  {
    args = [] as string[],
    cwd = process.cwd(),
    env = {},
  }: { args?: string[]; cwd?: string; env?: Record<string, string> } = {},
) {
  const hooks: Hook[] = [];
  const url = await startHookServer(hooks);
  const proc = spawn(process.execPath, [FAKE_CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      FAKE_CLI_SCENARIO: scenarioPath(scenario),
      PACT_HOOK_URL: url,
      PACT_AGENT_TOKEN: 'secret-token',
      ...env,
    },
  });
  child = proc;
  let stdout = '';
  proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve));

  const until = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!predicate()) throw new Error(`timed out waiting for ${what}\n--- stdout ---\n${stdout}`);
  };
  const prompts = () => stdout.split('> ').length - 1;
  return {
    hooks,
    proc,
    exited,
    output: () => stdout,
    types: () => hooks.map((h) => h.body.type),
    waitFor: (text: string) => until(() => stdout.includes(text), JSON.stringify(text)),
    waitForHook: (type: string) => until(() => hooks.some((h) => h.body.type === type), type),
    waitForPrompt: (count: number) => until(() => prompts() >= count, `prompt #${String(count)}`),
    send: (line: string) => proc.stdin.write(`${line}\n`),
  };
}

/** A PACT MCP server that answers every tools/call with `text`, recording the calls. */
async function startMcp(text: string) {
  const calls: { body: Record<string, unknown>; token: unknown }[] = [];
  const mcp = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ body, token: req.headers['x-pact-token'] });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
  const address = mcp.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    calls,
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: () => new Promise((resolve) => mcp.close(resolve)),
  };
}

describe('fake CLI', () => {
  it('shows a prompt, runs a turn and reports it through the hooks', async () => {
    const fake = await runFake('prompt-then-done', { args: ['--session-id', 'abc-123'] });
    await fake.waitFor('Session abc-123');
    await fake.waitForPrompt(1);
    fake.send('Ajoute un test');
    await fake.waitForPrompt(2);
    expect(fake.output()).toContain('Travail en cours\nTerminé\n');
    await fake.waitForHook('turn-finished');
    expect(fake.hooks.map((h) => h.body)).toEqual([
      { type: 'session-started', sessionId: 'abc-123' },
      { type: 'prompt-submitted', prompt: 'Ajoute un test' },
      { type: 'turn-finished' },
    ]);
    expect(fake.hooks.every((h) => h.headers['x-pact-token'] === 'secret-token')).toBe(true);
  });

  it('resumes an existing session', async () => {
    const fake = await runFake('prompt-then-done', { args: ['--resume', 'abc-123'] });
    await fake.waitFor('Session reprise abc-123');
    await fake.waitForHook('session-started');
    expect(fake.hooks[0]?.body).toEqual({ type: 'session-started', sessionId: 'abc-123' });
  });

  it.each([
    ['allow', 'Autorisé'],
    ['deny', 'Refusé'],
  ])('waits for the permission answer (%s) before finishing the turn', async (answer, echo) => {
    const fake = await runFake('ask-permission');
    await fake.waitForPrompt(1);
    fake.send('Nettoie');
    await fake.waitFor('? Exécuter : rm fichier.txt (allow/deny)');
    await fake.waitForHook('awaiting-answer');
    expect(fake.hooks.at(-1)?.body).toEqual({
      type: 'awaiting-answer',
      summary: 'rm fichier.txt',
      ruleKey: 'Bash(rm fichier.txt)',
    });

    fake.send('something else');
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.types()).not.toContain('turn-finished');

    fake.send(answer);
    await fake.waitFor(echo);
    await fake.waitForHook('turn-finished');
  });

  it('crashes with exit code 1', async () => {
    const fake = await runFake('crash-exit-1');
    await fake.waitForPrompt(1);
    fake.send('go');
    expect(await fake.exited).toBe(1);
    expect(fake.types()).toContain('failed');
  });

  it('exits on a rate limit, reporting the reset time', async () => {
    const fake = await runFake('rate-limit');
    await fake.waitForPrompt(1);
    fake.send('go');
    expect(await fake.exited).toBe(1);
    expect(fake.output()).toContain('Resets at 2030-01-01T09:30:00.000Z');
    expect(fake.hooks.at(-1)?.body).toMatchObject({
      type: 'failed',
      kind: 'rate-limit',
      resetAt: '2030-01-01T09:30:00.000Z',
    });
  });

  it('stays alive on a rate limit until told to continue', async () => {
    const fake = await runFake('rate-limit-alive');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('failed');
    fake.send('continue');
    await fake.waitFor('Reprise');
    await fake.waitForHook('turn-finished');
  });

  it('resumes on its own after a rate limit, like quota_auto_resume_fired', async () => {
    const fake = await runFake('rate-limit-native-resume');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('failed');
    await fake.waitForHook('prompt-submitted');
    await fake.waitFor('Reprise');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('quota_auto_resume_fired');
  });

  it('renames its branch', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-b', 'agent/fake-1');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init');

    const fake = await runFake('rename-branch', { cwd: tmp });
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('turn-finished');
    expect(git('branch', '--show-current').trim()).toBe('feature/login');
  });

  it('writes, renames, deletes and commits files in its folder (002 R11)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-b', 'agent/fake-1');
    await writeFile(join(tmp, 'old.txt'), 'old\n');
    await writeFile(join(tmp, 'gone.txt'), 'gone\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');

    const fake = await runFake('edit-files', { cwd: tmp });
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('turn-finished');
    expect(await readFile(join(tmp, 'src', 'Développement é.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(await readFile(join(tmp, 'new.txt'), 'utf8')).toBe('old\n');
    await expect(readFile(join(tmp, 'gone.txt'), 'utf8')).rejects.toThrow();
    expect(git('log', '-1', '--format=%s').trim()).toBe('Ajoute a');
    expect(git('status', '--porcelain', '--untracked-files=all').trim()).toBe('?? notes.md');
  });

  it('takes a bracketed paste as one prompt, line breaks included', async () => {
    const fake = await runFake('echo-prompt');
    await fake.waitForPrompt(1);
    fake.send('\x1b[200~Commentaire sur a.ts:3 — un');
    fake.send('deux\x1b[201~');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('Reçu : Commentaire sur a.ts:3 — un\ndeux\n');
    expect(fake.hooks[1]?.body).toEqual({
      type: 'prompt-submitted',
      prompt: 'Commentaire sur a.ts:3 — un\ndeux',
    });
  });

  it('FAKE_CLI_STRICT_PASTE: an Enter glued to the end of a paste is swallowed, a later one submits (fix-send-prompt)', async () => {
    const fake = await runFake('echo-prompt', { env: { FAKE_CLI_STRICT_PASTE: '1' } });
    await fake.waitForPrompt(1);
    fake.proc.stdin.write('\x1b[200~un\ndeux\x1b[201~\r');
    await new Promise((r) => setTimeout(r, 400));
    expect(fake.output()).not.toContain('Reçu');
    expect(fake.types()).not.toContain('prompt-submitted');
    fake.proc.stdin.write('\r');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('Reçu : un\ndeux\n');
  });

  it('FAKE_CLI_STRICT_PASTE: a one-line prompt typed with its Enter still goes through', async () => {
    const fake = await runFake('echo-prompt', { env: { FAKE_CLI_STRICT_PASTE: '1' } });
    await fake.waitForPrompt(1);
    fake.proc.stdin.write('simple\r');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('Reçu : simple');
  });

  it('without FAKE_CLI_STRICT_PASTE the glued Enter submits, as before', async () => {
    const fake = await runFake('echo-prompt');
    await fake.waitForPrompt(1);
    fake.proc.stdin.write('\x1b[200~collé\x1b[201~\r');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).toContain('Reçu : collé');
  });

  it('bursts output quickly', async () => {
    const fake = await runFake('burst-output');
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitFor('burst 2000\n');
  });

  it('calls a PACT tool over MCP with its own token, the prompt typed in its arguments (003 R11)', async () => {
    const calls: { body: Record<string, unknown>; token: unknown }[] = [];
    const mcp = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        calls.push({ body, token: req.headers['x-pact-token'] });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: 'Consigne en file' }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
    const address = mcp.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const fake = await runFake('orchestrate-prompt', {
        env: {
          PACT_ORCHESTRATOR_URL: `http://127.0.0.1:${String(port)}/mcp`,
          PACT_ORCHESTRATOR_TOKEN: 'orchestrator-token',
        },
      });
      await fake.waitForPrompt(1);
      fake.send('Codex 2|Écris les tests');
      await fake.waitFor('MCP send_prompt : Consigne en file');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.token).toBe('orchestrator-token');
      expect(calls[0]?.body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'send_prompt', arguments: { agent: 'Codex 2', text: 'Écris les tests' } },
      });
    } finally {
      await new Promise((resolve) => mcp.close(resolve));
    }
  });

  it('reads the workflow at the wake and plays the step of its stage (010 T004)', async () => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    let stage = 'test';
    const mcp = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { id: number; params: (typeof calls)[number] };
        calls.push(body.params);
        const content =
          body.params.name === 'get_workflow'
            ? [
                { type: 'text', text: 'workflow' },
                { type: 'text', text: JSON.stringify({ start: 'spec', run: { stage } }) },
              ]
            : [{ type: 'text', text: 'ok' }];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content } }));
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
    const address = mcp.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const fake = await runFake('workflow-steps', {
        env: {
          PACT_ORCHESTRATOR_URL: `http://127.0.0.1:${String(port)}/mcp`,
          PACT_ORCHESTRATOR_TOKEN: 'orchestrator-token',
        },
      });
      await fake.waitForPrompt(1);
      fake.send('0012-connexion');
      await fake.waitFor('MCP start_loop : ok');
      expect(fake.output()).toContain('MCP get_workflow : test');
      expect(calls.map((c) => c.name)).toEqual(['get_workflow', 'start_loop']);
      expect(calls[0]?.arguments).toEqual({ issue: '0012-connexion' });
      expect(calls[1]?.arguments).toMatchObject({ issue: '0012-connexion', dev: 'Claude Code 1' });

      stage = 'pr';
      fake.send('0012-connexion');
      await fake.waitFor('MCP request_delivery : ok');
      expect(calls.at(-1)?.name).toBe('request_delivery');

      stage = 'dev';
      fake.send('0012-connexion');
      await fake.waitForPrompt(4);
      expect(fake.output()).toContain('MCP get_workflow : dev');
      expect(calls.at(-1)?.name).toBe('get_workflow');
    } finally {
      await new Promise((resolve) => mcp.close(resolve));
    }
  });

  it('reports to PACT with its agent MCP token, never its hook token, one report per turn, the last one repeated (004 R5)', async () => {
    const mcp = await startMcp('Rapport reçu');
    try {
      const fake = await runFake('role-report', {
        env: { PACT_AGENT_MCP_URL: mcp.url, PACT_AGENT_MCP_TOKEN: 'agent-mcp-token' },
      });
      await fake.waitForPrompt(1);
      for (const turn of [1, 2, 3]) {
        fake.send('0012-connexion');
        await fake.waitForPrompt(turn + 1);
      }
      expect(fake.output()).toContain('MCP submit_report : Rapport reçu');
      expect(mcp.calls.map((c) => c.token)).toEqual([
        'agent-mcp-token',
        'agent-mcp-token',
        'agent-mcp-token',
      ]);
      const reports = mcp.calls.map(
        (c) => c.body.params as { name: string; arguments: Record<string, unknown> },
      );
      expect(reports.map((r) => r.name)).toEqual([
        'submit_report',
        'submit_report',
        'submit_report',
      ]);
      expect(reports.map((r) => r.arguments.status)).toEqual(['defects', 'done', 'done']);
      expect(reports[0]?.arguments).toMatchObject({
        issue: '0012-connexion',
        verdict: { result: 'defects', defects: ['a() renvoie 2'] },
      });
    } finally {
      await mcp.close();
    }
  });

  it('does not report without PACT’s agent MCP URL', async () => {
    const fake = await runFake('role-report');
    await fake.waitForPrompt(1);
    fake.send('0012-connexion');
    await fake.waitForHook('turn-finished');
    expect(fake.output()).not.toContain('submit_report');
  });

  it('writes tests, production code and a mockup in its folder (004 T003)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const fake = await runFake('role-files', { cwd: tmp });
    await fake.waitForPrompt(1);
    fake.send('go');
    await fake.waitForHook('turn-finished');
    expect(await readFile(join(tmp, 'tests', 'connexion.test.ts'), 'utf8')).toContain('connexion');
    expect(await readFile(join(tmp, 'src', 'connexion.ts'), 'utf8')).toContain('connexion');
    const mockup = await readFile(
      join(tmp, 'design', 'mockups', 'écran de connexion.html'),
      'utf8',
    );
    expect(mockup).toContain('<h1>écran de connexion</h1>');
  });

  it('commits on a usage-save read in .pact/events.md, without MCP (009)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-q');
    await mkdir(join(tmp, '.pact'));
    await writeFile(
      join(tmp, '.pact', 'events.md'),
      '# Événements PACT\n\n## 2030-01-01T09:00:00.000Z · usage-save · de PACT\n\nSauvegarde ton travail.\n',
    );
    const fake = await runFake('usage-stop', { cwd: tmp });
    await fake.waitForPrompt(1);
    fake.send('1 événement, lis .pact/events.md');
    await fake.waitForHook('turn-finished');
    expect(git('log', '--format=%s').trim()).toBe('pact: sauvegarde');
  });

  it('runs the statusLine of its settings with Claude Code’s payload, one per turn (005 R9)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const script = join(tmp, 'status.mjs');
    await writeFile(
      script,
      `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(tmp, 'payloads'))}, readFileSync(0, 'utf8') + '\\n');
console.log('PACT · 5 h 62 %');`,
    );
    const settings = {
      statusLine: { type: 'command', command: `"${process.execPath}" "${script}"` },
    };
    const fake = await runFake('usage-report', {
      args: ['--session-id', 's-1', '--settings', JSON.stringify(settings)],
    });
    await fake.waitForPrompt(1);
    fake.send('un');
    await fake.waitFor('Statut : PACT · 5 h 62 %');
    await fake.waitForPrompt(2);
    fake.send('deux');
    await fake.waitForPrompt(3);
    const payloads = (await readFile(join(tmp, 'payloads'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({
      session_id: 's-1',
      context_window: { total_input_tokens: 1200, total_output_tokens: 0 },
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: 1793721600 },
        seven_day: { used_percentage: 18, resets_at: 1793721600 + 5 * 86_400 },
      },
    });
    // Before a first answer, with an API key: no rate_limits at all.
    expect(payloads[1]).not.toHaveProperty('rate_limits');
    expect(payloads[1]).toMatchObject({ context_window: { total_input_tokens: 1500 } });
  });

  it('appends Codex token counts to the rollout of its session (005 R9)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pact-fake-'));
    const fake = await runFake('usage-rollout', {
      args: ['--session-id', 's-2'],
      env: { CODEX_HOME: tmp },
    });
    await fake.waitForPrompt(1);
    fake.send('un');
    await fake.waitForPrompt(2);
    fake.send('deux');
    await fake.waitForPrompt(3);
    const [year] = await readdir(join(tmp, 'sessions'));
    const [month] = await readdir(join(tmp, 'sessions', year ?? ''));
    const [day] = await readdir(join(tmp, 'sessions', year ?? '', month ?? ''));
    const dir = join(tmp, 'sessions', year ?? '', month ?? '', day ?? '');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^rollout-.+-s-2\.jsonl$/);
    const lines = (await readFile(join(dir, files[0] ?? ''), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
    expect(lines[0]?.payload).toMatchObject({
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 900 } },
      rate_limits: {
        primary: { used_percent: 18, window_minutes: 300, resets_at: 1793721600 },
        secondary: { used_percent: 4, window_minutes: 10_080 },
      },
    });
    expect(lines[1]?.payload).toMatchObject({ rate_limits: { primary: { used_percent: 25 } } });
    expect(lines[1]?.payload.rate_limits).not.toHaveProperty('secondary');
  });
});
