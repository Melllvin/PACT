import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// T146 — node-pty 1.1.0 kills a ConPTY terminal by asking a forked agent for the processes still
// attached to its console, then killing each of them. The pseudo-console is closed right after
// the fork, so the agent almost always fails (« AttachConsole failed ») and node-pty falls back,
// 5 s later, to killing the shell PID. Windows reuses PIDs quickly: that kill hit unrelated
// processes (git in the tests, any process of the user in PACT). Without a list, kill nothing.

const LIST_TIMEOUT_MS = 5000;

/** The part of a forked `conpty_console_list_agent` used here. */
export type ListAgent = {
  on(event: 'message', listener: (message: { consoleProcessList?: number[] }) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  kill(): unknown;
};

/** The processes the agent found on the console, or none when it could not tell. */
export function consoleProcessList(
  start: () => ListAgent,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<number[]> {
  return new Promise((resolve) => {
    const agent = start();
    const timeout = setTimeout(() => {
      agent.kill();
      resolve([]);
    }, timeoutMs);
    agent.on('message', (message) => {
      clearTimeout(timeout);
      resolve(message.consoleProcessList ?? []);
    });
    agent.on('exit', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}

type AgentPrototype = { _innerPid: number; _getConsoleProcessList: () => Promise<number[]> };

/**
 * Replaces node-pty's lookup on the class its Windows terminals use. Loaded at run time, so the
 * bundle never holds a second copy of the class.
 */
export function installConptyKillFix(): AgentPrototype['_getConsoleProcessList'] {
  const require = createRequire(import.meta.url);
  const agentPath = require.resolve('node-pty/lib/windowsPtyAgent');
  const { WindowsPtyAgent } = require(agentPath) as {
    WindowsPtyAgent: { prototype: AgentPrototype };
  };
  const script = join(dirname(agentPath), 'conpty_console_list_agent');
  WindowsPtyAgent.prototype._getConsoleProcessList = function (this: AgentPrototype) {
    const pid = this._innerPid;
    return pid > 0 ? consoleProcessList(() => fork(script, [String(pid)])) : Promise.resolve([]);
  };
  return WindowsPtyAgent.prototype._getConsoleProcessList;
}
