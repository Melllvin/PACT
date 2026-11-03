/* global process */
// 004 US3 — a fake `gh` for the end-to-end tests: `repo view` answers when FAKE_GH_REMOTE is set,
// `issue create` prints the URL of the next issue and logs its arguments to FAKE_GH_LOG.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const { FAKE_GH_REMOTE: remote, FAKE_GH_LOG: log } = process.env;
if (!remote) {
  process.stderr.write('no git remotes found\n');
  process.exit(1);
}
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(`${JSON.stringify({ url: remote })}\n`);
} else if (args[0] === 'issue' && args[1] === 'create') {
  let count = 0;
  try {
    count = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    // First issue.
  }
  appendFileSync(log, `${JSON.stringify(args)}\n`);
  process.stdout.write(`${remote}/issues/${String(count + 1)}\n`);
} else {
  process.stderr.write(`unknown command: ${args.join(' ')}\n`);
  process.exit(1);
}
