import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenericAdapter } from '../../src/main/agents/adapters/generic';
import { runCliAdapterContract } from './cli-adapter.contract';

// T094 — « Autre CLI » (FR-008): a command typed by the user, followed through its terminal only.

runCliAdapterContract(
  'generic',
  ({ platform }) => new GenericAdapter({ command: 'aider --no-git', platform }),
  { opaqueCommand: true },
);

describe('generic adapter specifics', () => {
  const now = new Date(2030, 0, 1, 9, 0);
  const adapter = new GenericAdapter({
    command: 'aider --no-git',
    platform: 'darwin',
    now: () => now,
  });
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('runs the resolved executable with the arguments typed after the command', () => {
    const spec = adapter.buildLaunch({
      agentId: '00000000-0000-4000-8000-000000000001',
      executablePath: '/usr/local/bin/aider',
      repoPath: '/r',
      cwd: '/w',
      model: 'gpt-5',
      permissionLevel: 'always-allow',
      port: 3001,
      hook: { url: 'http://127.0.0.1:1', token: 't' },
    });
    expect(spec.file).toBe('/usr/local/bin/aider');
    expect(spec.args).toEqual(['--no-git']);
  });

  it('is installed when its command is found in PATH, missing otherwise', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pact-generic-'));
    const executable = join(dir, 'aider');
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
    expect(await adapter.detect({ PATH: dir })).toEqual({
      resolvedPath: executable,
      version: null,
      status: 'installed',
    });
    expect(await adapter.detect({ PATH: tmpdir() })).toEqual({
      resolvedPath: null,
      version: null,
      status: 'missing',
    });
  });

  it('offers no model: the CLI keeps its own default', async () => {
    expect(await adapter.listModels()).toEqual([]);
  });

  describe('mapOutput', () => {
    it('reports a question once the output has been idle for 3 s', () => {
      expect(adapter.mapOutput('Working…\nApply these edits? ', { idleMs: 3000 })).toEqual({
        type: 'awaiting-answer',
        summary: 'Apply these edits?',
      });
      expect(adapter.mapOutput('Delete 3 files (Y/n)', { idleMs: 4200 })).toEqual({
        type: 'awaiting-answer',
        summary: 'Delete 3 files (Y/n)',
      });
    });

    it('waits for the 3 s of silence before reporting it', () => {
      expect(adapter.mapOutput('Apply these edits?', {})).toBeNull();
      expect(adapter.mapOutput('Apply these edits?', { idleMs: 1000 })).toBeNull();
    });

    it('does not take any idle output for a question', () => {
      expect(adapter.mapOutput('Done. 3 files changed.\n', { idleMs: 5000 })).toBeNull();
      expect(adapter.mapOutput('', { idleMs: 5000 })).toBeNull();
    });

    it('ends the turn when the process exits with 0, fails otherwise', () => {
      expect(adapter.mapOutput('', { exitCode: 0 })).toEqual({ type: 'turn-finished' });
      expect(adapter.mapOutput('', { exitCode: 2 })).toEqual({
        type: 'failed',
        kind: 'crash',
        message: 'Le processus s’est arrêté (code 2).',
      });
    });
  });

  it('answers a (y/n) question with y or n', () => {
    expect(adapter.answerKeys('allow')).toBe('y\r');
    expect(adapter.answerKeys('deny')).toBe('n\r');
  });

  it('reads a reset time written like « try again at 3pm » or « resets 9:30am »', () => {
    expect(adapter.parseRateLimitReset('Rate limit reached, try again at 3pm')).toEqual(
      new Date(2030, 0, 1, 15, 0),
    );
    expect(adapter.parseRateLimitReset('Usage limit, resets 9:30am')).toEqual(
      new Date(2030, 0, 1, 9, 30),
    );
    expect(adapter.parseRateLimitReset('Rate limit reached')).toBeNull();
  });
});
