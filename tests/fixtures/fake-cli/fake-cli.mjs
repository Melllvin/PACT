import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const scenario = JSON.parse(await readFile(process.env.FAKE_CLI_SCENARIO, 'utf8'));
const hook = async (payload) => {
  if (!process.env.PACT_HOOK_URL) return;
  await fetch(process.env.PACT_HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pact-token': process.env.PACT_AGENT_TOKEN ?? '',
    },
    body: JSON.stringify(payload),
  });
};
await hook({ type: 'session-started', sessionId: process.argv.at(-1) });
process.stdout.write('> ');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  await hook({ type: 'prompt-submitted', prompt: line });
  for (const output of scenario.output ?? []) console.log(output);
  if (scenario.permission) {
    console.log(`? Exécuter : ${scenario.permission}`);
    await hook({ type: 'awaiting-answer', summary: scenario.permission });
    return;
  }
  await hook(scenario.signal ?? { type: 'turn-finished' });
  if (scenario.exitCode !== undefined) process.exit(scenario.exitCode);
  process.stdout.write('> ');
});
