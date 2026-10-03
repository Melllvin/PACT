/* global process, console, fetch, setTimeout */
// Fake agent CLI (research.md R13): replays the JSON scenario named by FAKE_CLI_SCENARIO so PTY,
// hook and lifecycle behavior can be tested deterministically without a real agent or account.
//
// Scenario fields (all optional):
//   output: string[]                lines printed for each prompt
//   burst: number                   extra lines printed as fast as possible
//   permission: string              asks `? Exécuter : <cmd> (allow/deny)` and waits for the answer,
//                                   unless the hook reply already allows it (ruleKey `Bash(<cmd>)`)
//   rateLimit: { resetAt, exit, nativeResume }
//                                   prints a rate-limit message; exits (code 1), resumes on its own
//                                   like Claude Code's quota_auto_resume_fired, or waits for "continue"
//   hooks: object[]                 raw hook payloads posted after the output
//   renameBranch: string            runs `git branch -m <name>` in the working directory
//   files: object[]                 edits the working directory in order (002 R11):
//                                   { write, content } | { delete } | { rename: [from, to] }
//                                   | { commit: message } (stages everything first)
//   echo: boolean                   prints `Reçu : <prompt>`, to check what PACT typed
//   signal: object                  final hook payload (default { type: 'turn-finished' })
//   exitCode: number                exits with this code after the turn
//
// A bracketed paste (ESC[200~ … ESC[201~) is one prompt, its line breaks included, as in the
// real CLIs (002 R7).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

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

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[
  Symbol.asyncIterator
]();
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

  if (scenario.permission) {
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

  if (scenario.rateLimit) {
    const { resetAt, exit, nativeResume } = scenario.rateLimit;
    console.log(`Rate limit reached. Resets at ${resetAt}`);
    await hook({ type: 'failed', kind: 'rate-limit', message: 'Rate limited', resetAt });
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

  for (const payload of scenario.hooks ?? []) await hook(payload);
  editFiles(scenario.files ?? []);
  if (scenario.renameBranch) {
    execFileSync('git', ['branch', '-m', scenario.renameBranch], { stdio: 'ignore' });
  }

  await hook(scenario.signal ?? { type: 'turn-finished' });
  if (scenario.exitCode !== undefined) process.exit(scenario.exitCode);
}

console.log(resumed ? `Session reprise ${resumed}` : `Session ${sessionId}`);
await hook({ type: 'session-started', sessionId });
for (;;) {
  prompt();
  const line = await nextPrompt();
  if (line) await runTurn(line);
}
