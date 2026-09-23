import { join } from 'node:path';
import {
  launchEnv,
  type AgentSignal,
  type CliAdapter,
  type LaunchInput,
  type OutputContext,
} from './types.js';
export class FakeAdapter implements CliAdapter {
  readonly id = 'fake';
  async detect() {
    return {
      resolvedPath: process.execPath,
      version: process.version,
      status: 'installed' as const,
    };
  }
  async listModels() {
    return ['fake'];
  }
  buildLaunch(i: LaunchInput) {
    return {
      file: process.execPath,
      args: [
        join(process.cwd(), 'tests/fixtures/fake-cli/fake-cli.mjs'),
        '--session-id',
        i.sessionId ?? crypto.randomUUID(),
      ],
      env: launchEnv(i),
      cwd: i.cwd,
    };
  }
  buildResume(i: LaunchInput & { sessionId: string }) {
    const spec = this.buildLaunch(i);
    spec.args.push('--resume', i.sessionId);
    return spec;
  }
  mapHookEvent(p: unknown): AgentSignal | null {
    return typeof p === 'object' && p !== null && 'type' in p ? (p as AgentSignal) : null;
  }
  mapOutput(..._args: [string, OutputContext]) {
    void _args;
    return null;
  }
  answerKeys(a: 'allow' | 'deny') {
    return `${a}\r`;
  }
  parseRateLimitReset(text: string) {
    const match = text.match(/(?:until|jusqu.?à)\s+(.+)$/i);
    if (!match?.[1]) return null;
    const date = new Date(match[1]);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
}
