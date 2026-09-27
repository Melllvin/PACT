import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consoleProcessList,
  installConptyKillFix,
  type ListAgent,
} from '../../../../src/main/pty/conpty-kill';
import '../../../../src/main/pty/pty-manager';

// T146 — a ConPTY kill never falls back to killing a PID Windows may have given to another process.

class FakeAgent extends EventEmitter implements ListAgent {
  killed = false;
  kill() {
    this.killed = true;
  }
}

const start = (agent: FakeAgent) => () => agent;

afterEach(() => {
  vi.useRealTimers();
});

describe('consoleProcessList', () => {
  it('returns the processes the agent found on the console', async () => {
    const agent = new FakeAgent();
    const list = consoleProcessList(start(agent));
    agent.emit('message', { consoleProcessList: [12, 34] });
    expect(await list).toEqual([12, 34]);
  });

  it('kills nothing when the agent could not attach to the console and exited', async () => {
    const agent = new FakeAgent();
    const list = consoleProcessList(start(agent));
    agent.emit('exit');
    expect(await list).toEqual([]);
  });

  it('kills nothing when the agent does not answer in time, instead of the shell PID', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgent();
    const list = consoleProcessList(start(agent), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await list).toEqual([]);
    expect(agent.killed).toBe(true);
  });

  it('keeps the list when the agent exits after answering', async () => {
    const agent = new FakeAgent();
    const list = consoleProcessList(start(agent));
    agent.emit('message', { consoleProcessList: [7] });
    agent.emit('exit');
    expect(await list).toEqual([7]);
  });
});

describe('installConptyKillFix', () => {
  const agentClass = () =>
    (
      createRequire(import.meta.url)('node-pty/lib/windowsPtyAgent') as {
        WindowsPtyAgent: { prototype: { _getConsoleProcessList: unknown } };
      }
    ).WindowsPtyAgent;

  it('is installed on the class node-pty builds its Windows terminals from', () => {
    const installed = agentClass().prototype._getConsoleProcessList;
    expect(installConptyKillFix().toString()).toBe(String(installed));
  });

  it('asks nothing for a terminal without a shell PID', async () => {
    const lookup = installConptyKillFix();
    expect(await lookup.call({ _innerPid: 0, _getConsoleProcessList: lookup })).toEqual([]);
  });

  it('kills nothing when the console list agent cannot run', async () => {
    // Outside Windows the agent's native module is missing: it exits without an answer.
    const lookup = installConptyKillFix();
    expect(await lookup.call({ _innerPid: 1, _getConsoleProcessList: lookup })).toEqual([]);
  }, 10_000);
});
