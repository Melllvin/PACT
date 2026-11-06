/* global process, console, fetch, setTimeout */
// Fake agent CLI (research.md R13): replays the JSON scenario named by FAKE_CLI_SCENARIO so PTY,
// hook and lifecycle behavior can be tested deterministically without a real agent or account.
//
// Scenario fields (all optional):
//   output: string[]                lines printed for each prompt
//   burst: number                   extra lines printed as fast as possible
//   permission: string              asks `? Exécuter : <cmd> (allow/deny)` and waits for the answer,
//                                   unless the hook reply already allows it (ruleKey `Bash(<cmd>)`)
//   rateLimit: { resetAt?, exit, nativeResume }
//                                   prints a rate-limit message, without a time when no resetAt;
//                                   exits (code 1), resumes on its own like Claude Code's
//                                   quota_auto_resume_fired, or waits for "continue"
//   permissionOn: string            with `permission`, asks only when the prompt contains this text
//                                   (006: one agent of several asks)
//   hooks: object[]                 raw hook payloads posted after the output
//   renameBranch: string            runs `git branch -m <name>` in the working directory
//   files: object[]                 edits the working directory in order (002 R11):
//                                   { write, content } | { delete } | { rename: [from, to] }
//                                   | { commit: message } (stages everything first)
//   echo: boolean                   prints `Reçu : <prompt>`, to check what PACT typed
//   mcp: { tool, arguments }[]      calls these PACT tools when it is the orchestrator (003 R11), on
//                                   PACT_ORCHESTRATOR_URL with PACT_ORCHESTRATOR_TOKEN, and prints
//                                   `MCP <tool> : <text>`. In string arguments, `{{prompt}}` is the
//                                   prompt typed and `{{prompt.N}}` its N-th `|`-separated part.
//                                   `tool` is filled the same way; `json` instead of `arguments`
//                                   is filled, then parsed as the arguments (004 e2e)
//   report: object | object[]       calls `submit_report` with it on PACT_AGENT_MCP_URL, with the
//                                   agent's PACT_AGENT_MCP_TOKEN (004 R5), and prints
//                                   `MCP submit_report : <text>`; an array gives one report per
//                                   turn, the last one repeated. `{{prompt}}` is filled as for `mcp`
//   writeTests: string[]            writes `tests/<name>.test.ts` for each name (004)
//   writeProd: string[]             writes `src/<name>.ts` for each name (004)
//   mockup: string                  writes `design/mockups/<name>.html` (004)
//   usage: object | object[]        { five_hour, seven_day, resets_at, tokens } (005 R9): runs the
//                                   statusLine command of its --settings with the payload Claude
//                                   Code would send (no rate_limits without five_hour/seven_day),
//                                   and prints `Statut : <its output>`; an array gives one per turn
//   rollout: object | object[]      { primary, secondary, resets_at, tokens } (005 R9): appends a
//                                   Codex token_count to $CODEX_HOME/sessions/AAAA/MM/JJ/
//                                   rollout-<time>-<session>.jsonl; an array gives one per turn
//   signal: object                  final hook payload (default { type: 'turn-finished' })
//   agentMcp: { tool, arguments }[] calls these PACT tools when it is an agent of a role (007 R16),
//                                   on PACT_AGENT_MCP_URL with its token, and prints
//                                   `MCP <tool> : <text>`; `{{prompt}}` is filled as for `mcp`
//   toolHook: boolean               posts `{ type: 'post-tool' }` (a PostToolUse) during the turn and
//                                   prints `Contexte : <additionalContext>` when PACT answers one
//
// A line that is a PACT pointer (« N événement(s), lis get_events » or « …, lis <file> ») is not a
// prompt (007 R16): with PACT_AGENT_MCP_URL or PACT_ORCHESTRATOR_URL the CLI calls `get_events`,
// then `get_events({ id })` on the first `instruction`, and plays the turn with that text, as if it
// had been typed; without MCP it reads `.pact/events.md` and plays its content. A pointer with no
// instruction plays as itself. Scenarios keep their `{{prompt}}`.
//
// A final hook answered `{ decision: 'block', reason }` (Stop prolonged by a wake) prints
// `Prolongé : <reason>` and plays one more turn with the reason, which is a pointer.
//   exitCode: number                exits with this code after the turn
//
// A bracketed paste (ESC[200~ … ESC[201~) is one prompt, its line breaks included, as in the
// real CLIs (002 R7).
//
// FAKE_CLI_STRICT_PASTE=1 (fix-send-prompt): like Claude Code, an Enter received in the SAME
// chunk as the end of a paste is swallowed. Only an Enter arriving in a later chunk submits.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const scenario = JSON.parse(readFileSync(process.env.FAKE_CLI_SCENARIO ?? '', 'utf8'));
const resumed = argValue('--resume');
const sessionId = resumed ?? argValue('--session-id') ?? 'fake-session';

/** Posts a hook payload and resolves with PACT's reply, like a blocking CLI hook. */
async function hook(payload) {
  const url = process.env.PACT_HOOK_URL;
  if (!url) return undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pact-token': process.env.PACT_AGENT_TOKEN ?? '',
      },
      body: JSON.stringify(payload),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    // PACT may be gone: a CLI never crashes because a hook failed.
    return undefined;
  }
}

/** stdin, or in strict-paste mode a copy that drops the Enter glued to the end of a paste. */
const input = (() => {
  if (process.env.FAKE_CLI_STRICT_PASTE !== '1') return process.stdin;
  const filtered = new PassThrough();
  process.stdin.on('data', (chunk) => {
    // The tty turns the carriage return into a line feed before it reaches us.
    // eslint-disable-next-line no-control-regex -- the escape of a bracketed paste
    filtered.write(String(chunk).replace(/(\x1b\[201~)(\r\n|\r|\n)$/, '$1'));
  });
  process.stdin.on('end', () => filtered.end());
  return filtered;
})();

const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
const nextLine = async () => {
  const { value, done } = await lines.next();
  if (done) process.exit(0);
  return value.trim();
};
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Reads one prompt: a single line, or every line of a bracketed paste. */
const nextPrompt = async () => {
  let line = await nextLine();
  if (!line.startsWith(PASTE_START)) return line;
  const parts = [line.slice(PASTE_START.length)];
  while (!line.includes(PASTE_END)) parts.push((line = await nextLine()));
  return parts.join('\n').replace(PASTE_END, '').trim();
};
const prompt = () => process.stdout.write('> ');

/** `{{prompt}}` and `{{prompt.N}}` in the string values of `args`, from the prompt typed. */
function fillArguments(args, line) {
  const parts = line.split('|');
  const fill = (value) =>
    typeof value !== 'string'
      ? value
      : value
          .replaceAll('{{prompt}}', line)
          .replace(/\{\{prompt\.(\d+)\}\}/g, (_, n) => parts[Number(n)] ?? '');
  return Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => [key, fill(value)]));
}

/** One `tools/call` to PACT's MCP server, as Claude Code makes it. */
async function callTool(
  tool,
  args,
  url = process.env.PACT_ORCHESTRATOR_URL,
  token = process.env.PACT_ORCHESTRATOR_TOKEN,
) {
  try {
    const response = await fetch(url ?? '', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-pact-token': token ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    if (!response.ok) return `HTTP ${String(response.status)}`;
    const reply = await response.json();
    return reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error ?? reply);
  } catch (error) {
    return `injoignable (${error.message})`;
  }
}

/** `tools/call` with the text and the JSON PACT answers (`get_events` gives both). */
async function callToolFull(tool, args) {
  const url = process.env.PACT_AGENT_MCP_URL ?? process.env.PACT_ORCHESTRATOR_URL;
  const token = process.env.PACT_AGENT_MCP_URL
    ? process.env.PACT_AGENT_MCP_TOKEN
    : process.env.PACT_ORCHESTRATOR_TOKEN;
  try {
    const response = await fetch(url ?? '', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-pact-token': token ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    if (!response.ok) return { text: `HTTP ${String(response.status)}`, json: null };
    const reply = await response.json();
    const [text, json] = (reply.result?.content ?? []).map((c) => c.text);
    return {
      text: text ?? JSON.stringify(reply.error ?? reply),
      json: json ? JSON.parse(json) : null,
    };
  } catch (error) {
    return { text: `injoignable (${error.message})`, json: null };
  }
}

const POINTER = /^\d+ événements?, lis \S+$/;

/** What a pointer makes the CLI play: the first instruction it reads, else the pointer itself. */
async function readPointer(line) {
  if (!process.env.PACT_AGENT_MCP_URL && !process.env.PACT_ORCHESTRATOR_URL) {
    try {
      return readFileSync(join(process.cwd(), '.pact', 'events.md'), 'utf8').trim() || line;
    } catch {
      return line;
    }
  }
  const list = await callToolFull('get_events', {});
  console.log(`MCP get_events : ${list.text}`);
  const first = (list.json?.events ?? []).find((event) => event.kind === 'instruction');
  if (!first) return line;
  const detail = await callToolFull('get_events', { id: first.id });
  console.log(`MCP get_events : ${detail.text}`);
  return detail.json?.event?.text ?? line;
}

/** Fills `{{prompt}}` and `{{prompt.N}}` in every string of a value, at any depth. */
function fillDeep(value, line) {
  if (typeof value === 'string') return fillArguments({ value }, line).value;
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, line));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, line)]));
  }
  return value;
}

/** The files an agent of a role writes (004): tests, production code, a mockup. */
function writeRoleFiles() {
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  for (const name of scenario.writeTests ?? []) {
    write(`tests/${name}.test.ts`, `// Test de ${name}\n`);
  }
  for (const name of scenario.writeProd ?? []) write(`src/${name}.ts`, `// ${name}\n`);
  if (scenario.mockup) {
    write(
      `design/mockups/${scenario.mockup}.html`,
      `<!doctype html>\n<meta charset="utf-8">\n<h1>${scenario.mockup}</h1>\n`,
    );
  }
}

/** The step of this turn: an array gives one per turn, its last one repeated. */
const ofTurn = (steps) => {
  const all = [steps ?? []].flat();
  return all[Math.min(turn, all.length - 1)];
};

/** Splits a command as a POSIX shell does: '…', "…" and \\ escapes. */
function shellWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === '\\') {
      word = (word ?? '') + (command[++i] ?? '');
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** Claude Code's statusLine, run as it would run it (005 R1, R9). */
function reportUsage(usage) {
  const settings = argValue('--settings');
  const command = settings ? JSON.parse(settings).statusLine?.command : undefined;
  if (!command) return;
  const resetsAt = usage.resets_at ?? Math.floor(Date.now() / 1000) + 2 * 3600;
  const limits = {};
  if (usage.five_hour !== undefined) {
    limits.five_hour = { used_percentage: usage.five_hour, resets_at: resetsAt };
  }
  if (usage.seven_day !== undefined) {
    limits.seven_day = { used_percentage: usage.seven_day, resets_at: resetsAt + 5 * 86_400 };
  }
  const payload = {
    session_id: sessionId,
    model: { id: 'fake', display_name: 'Faux' },
    context_window: { total_input_tokens: usage.tokens ?? 0, total_output_tokens: 0 },
    ...(Object.keys(limits).length > 0 ? { rate_limits: limits } : {}),
  };
  try {
    // Run without a shell, like a POSIX shell would split it: Windows' cmd.exe would not.
    const words = shellWords(command);
    const env = { ...process.env };
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
      const [name, ...value] = (words.shift() ?? '').split('=');
      env[name] = value.join('=');
    }
    const [file, ...args] = words;
    const output = execFileSync(file, args, {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env,
    });
    console.log(`Statut : ${output.trim()}`);
  } catch {
    // Like Claude Code: a statusLine that fails leaves the line empty.
  }
}

/** Codex's rollout of this session (005 R2, R9). */
function writeRollout(rollout) {
  const home = process.env.CODEX_HOME;
  if (!home) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10).split('-');
  const dir = join(home, 'sessions', ...day);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  const resetsAt = rollout.resets_at ?? Math.floor(now.getTime() / 1000) + 2 * 3600;
  const limit = (used_percent, window_minutes) =>
    used_percent === undefined ? undefined : { used_percent, window_minutes, resets_at: resetsAt };
  const line = {
    timestamp: now.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: rollout.tokens ?? 0, output_tokens: 0 } },
      rate_limits: {
        primary: limit(rollout.primary, 300),
        secondary: limit(rollout.secondary, 10_080),
      },
    },
  };
  rolloutFile ??= join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  appendFileSync(rolloutFile, `${JSON.stringify(line)}\n`);
}
let rolloutFile;

let turn = 0;

function editFiles(steps) {
  const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
  for (const step of steps) {
    if (step.write !== undefined) {
      mkdirSync(dirname(step.write), { recursive: true });
      writeFileSync(step.write, step.content ?? '');
    } else if (step.delete !== undefined) {
      rmSync(step.delete);
    } else if (step.rename) {
      renameSync(step.rename[0], step.rename[1]);
    } else if (step.commit !== undefined) {
      git('add', '-A');
      git(
        '-c',
        'user.name=Fake CLI',
        '-c',
        'user.email=fake@pact.test',
        'commit',
        '-m',
        step.commit,
      );
    }
  }
}

async function runTurn(line) {
  await hook({ type: 'prompt-submitted', prompt: line });
  if (scenario.echo) console.log(`Reçu : ${line}`);
  for (const text of scenario.output ?? []) console.log(text);
  for (let i = 1; i <= (scenario.burst ?? 0); i++) console.log(`burst ${String(i)}`);

  if (scenario.permission && (!scenario.permissionOn || line.includes(scenario.permissionOn))) {
    console.log(`? Exécuter : ${scenario.permission} (allow/deny)`);
    const reply = await hook({
      type: 'awaiting-answer',
      summary: scenario.permission,
      ruleKey: `Bash(${scenario.permission})`,
    });
    // Claude Code's PermissionRequest decision: no dialog left to answer.
    let answer = reply?.hookSpecificOutput?.decision?.behavior;
    while (answer !== 'allow' && answer !== 'deny') answer = await nextLine();
    console.log(answer === 'allow' ? 'Autorisé' : 'Refusé');
  }

  // The limits of the turn are known before its rate limit, as Claude Code's statusLine tells them.
  const usage = ofTurn(scenario.usage);
  if (usage) reportUsage(usage);
  const rollout = ofTurn(scenario.rollout);
  if (rollout) writeRollout(rollout);

  if (scenario.rateLimit) {
    const { resetAt, exit, nativeResume } = scenario.rateLimit;
    // Without `resetAt`, the message gives no time (005 FR-015).
    console.log(resetAt ? `Rate limit reached. Resets at ${resetAt}` : 'Rate limit reached.');
    await hook({
      type: 'failed',
      kind: 'rate-limit',
      message: 'Rate limited',
      ...(resetAt ? { resetAt } : {}),
    });
    if (exit) process.exit(1);
    if (nativeResume) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      console.log('quota_auto_resume_fired');
      await hook({ type: 'prompt-submitted' });
    } else {
      while ((await nextLine()) !== 'continue');
    }
    console.log('Reprise');
  }

  // Only the orchestrator gets PACT's tools; the agents it leads skip these steps.
  for (const step of process.env.PACT_ORCHESTRATOR_URL ? (scenario.mcp ?? []) : []) {
    const tool = fillDeep(step.tool, line);
    const args =
      step.json === undefined
        ? fillArguments(step.arguments, line)
        : JSON.parse(fillDeep(step.json, line));
    console.log(`MCP ${tool} : ${await callTool(tool, args)}`);
  }
  if (scenario.toolHook) {
    const reply = await hook({ type: 'post-tool' });
    const context = reply?.hookSpecificOutput?.additionalContext;
    if (context) console.log(`Contexte : ${context}`);
  }
  for (const step of process.env.PACT_AGENT_MCP_URL ? (scenario.agentMcp ?? []) : []) {
    const args = fillArguments(step.arguments, line);
    const { text } = await callToolFull(step.tool, args);
    console.log(`MCP ${step.tool} : ${text}`);
  }
  for (const payload of scenario.hooks ?? []) await hook(payload);
  editFiles(scenario.files ?? []);
  writeRoleFiles();
  const reports = [scenario.report ?? []].flat();
  if (process.env.PACT_AGENT_MCP_URL && reports.length > 0) {
    const report = reports[Math.min(turn, reports.length - 1)];
    const text = await callTool(
      'submit_report',
      fillDeep(report, line),
      process.env.PACT_AGENT_MCP_URL,
      process.env.PACT_AGENT_MCP_TOKEN,
    );
    console.log(`MCP submit_report : ${text}`);
  }
  turn += 1;
  if (scenario.renameBranch) {
    execFileSync('git', ['branch', '-m', scenario.renameBranch], { stdio: 'ignore' });
  }

  const end = await hook(scenario.signal ?? { type: 'turn-finished' });
  if (scenario.exitCode !== undefined) process.exit(scenario.exitCode);
  // A Stop prolonged by a wake: the reason is a pointer, and the turn goes on.
  if (end?.decision === 'block' && typeof end.reason === 'string') {
    console.log(`Prolongé : ${end.reason}`);
    await play(end.reason);
  }
}

/** A line typed or a reason given: a pointer is read, anything else is the prompt. */
async function play(line) {
  await runTurn(POINTER.test(line) ? await readPointer(line) : line);
}

console.log(resumed ? `Session reprise ${resumed}` : `Session ${sessionId}`);
await hook({ type: 'session-started', sessionId });
for (;;) {
  prompt();
  const line = await nextPrompt();
  if (line) await play(line);
}
