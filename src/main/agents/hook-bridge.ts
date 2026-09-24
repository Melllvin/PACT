// research.md R4 — hook command for CLIs that only run command hooks (e.g. Codex). Launched as
// `"<Electron>" hook-bridge.js` with ELECTRON_RUN_AS_NODE=1, so users need neither Node nor curl.
// It forwards the JSON payload read from stdin to PACT and prints PACT's answer on stdout.
// Keep this file free of dependencies: it is bundled on its own.
import { pathToFileURL } from 'node:url';

type RelayOptions = {
  stdin: AsyncIterable<Buffer | string>;
  stdout: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
};

export async function relayHook({ stdin, stdout, env }: RelayOptions): Promise<void> {
  const url = env.PACT_HOOK_URL;
  if (!url) return;
  let body = '';
  for await (const chunk of stdin) body += chunk.toString();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pact-token': env.PACT_AGENT_TOKEN ?? '' },
      body: body || '{}',
    });
    if (response.ok) stdout.write(await response.text());
  } catch {
    // PACT is gone or restarting: a hook must never make the agent CLI fail.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void relayHook({ stdin: process.stdin, stdout: process.stdout, env: process.env });
}
