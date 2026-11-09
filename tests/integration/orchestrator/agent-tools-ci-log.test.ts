import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTools, eventsNote } from '../../../src/main/orchestrator/agent-tools';
import type { AgentToolDependencies } from '../../../src/main/orchestrator/agent-tools';
import { MAX_CI_LOG } from '../../../src/shared/delivery';
import { createDeliveryHarness, type DeliveryHarness } from '../delivery/delivery-harness';

// 008 T042 — `get_ci_log` (US4 sc.8, research R15, contracts/mcp-tools.md): the dev of a request whose PR
// PACT follows reads the log of a failed check, bounded to its last 20 000 characters and followed by
// the note of 007 on reported data. Everything else is refused WITHOUT reading anything: no `gh run view`
// leaves (a PR that is not followed, a fork, a request that fell, another agent, a check that is not on
// the current head, a check with no job of Actions). The real DeliveryService and the contractual fake
// `gh` (journal of every call) stand behind the tool, as the app wires them.
//
// RED until T045. THE API THIS FILE ASSUMES (the dev implements it; a change of it is a change of these
// tests, listed in the report):
//   createAgentTools({ delivery }, agentId) adds the tool `get_ci_log` ({ check: string }) when
//     `deps.delivery` is given; the tool calls `deps.delivery.ciLog(agentId, check)`, which resolves
//     `{ check, conclusion, log }` or throws an `IpcFailure` carrying the reason of the refusal, and
//     answers like the other tools of agent-tools.ts: content[0] a sentence, content[1] the JSON
//     `{ check, conclusion, log, note }` (note = eventsNote); a refusal is `isError: true`.
//   a request whose CI turned red is `ci-red` (final) yet its dev still reads the log: the PR is kept and
//     it is followed up to the next request (data-model: « une demande finale garde pr »). The dev of a
//     `dropped`, `refused` or never-delivered request gets nothing. The check is looked for by name
//     among the checks saved of the PR's current head; the PR is read again to refuse a fork.

let h: DeliveryHarness;
afterEach(async () => {
  await h.dispose();
});

const runViews = () => h.ghLog().filter(([a, b]) => a === 'run' && b === 'view');
const toolsOf = (agentId: string) =>
  createAgentTools({ delivery: h.delivery } as unknown as AgentToolDependencies, agentId);
const callLog = async (agentId: string, check: string) => {
  const tool = toolsOf(agentId).find((t) => t.name === 'get_ci_log');
  expect(tool, 'the tool get_ci_log is offered').toBeDefined();
  return tool?.call({ check });
};
const answerOf = (result: Awaited<ReturnType<typeof callLog>>) =>
  JSON.parse(result?.content[1]?.text ?? '{}') as {
    check: string;
    conclusion: string;
    log: string;
    note: string;
  };

const failing = (name: string, id: number) => ({
  id,
  name,
  status: 'completed',
  conclusion: 'failure',
});

/** A delivered dev whose CI is red on the head: the request is `ci-red`, the PR #1 kept. */
async function red(suffix = 'a', checks = [failing('ci', 77)]) {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  await h.until(request.id, ['watching']);
  const head = h.prHead(1);
  h.setChecks(head, checks);
  await h.until(request.id, ['ci-red']);
  return { ...team, id: request.id, head };
}

describe('the log of a failed check, for the dev of a followed PR (sc.8)', () => {
  it('Given a red check of a followed PR, When the dev asks for its log, Then it receives the end of the log, bounded, with the note on reported data, and gh read that one job', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    h.setGhState({ logs: { '77': `début ${'y'.repeat(30_000)} FIN` } });
    const { dev } = await red();

    const result = await callLog(dev.id, 'ci');

    expect(result?.isError).toBeUndefined();
    const answer = answerOf(result);
    expect(answer.check).toBe('ci');
    expect(answer.conclusion).toBe('failure');
    expect(answer.log.length).toBeLessThanOrEqual(MAX_CI_LOG);
    expect(answer.log.endsWith('FIN')).toBe(true);
    expect(answer.log).not.toContain('début');
    expect(answer.note).toBe(eventsNote);
    expect(runViews()).toEqual([['run', 'view', '--job', '77', '--log-failed']]);
  });

  it('Given a short log, When the dev asks for it, Then it receives all of it', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    h.setGhState({ logs: { '77': 'expected 1 to be 2\n  at tests/a.test.ts:3' } });
    const { dev } = await red();

    const answer = answerOf(await callLog(dev.id, 'ci'));

    expect(answer.log).toBe('expected 1 to be 2\n  at tests/a.test.ts:3');
  });
});

describe('what is refused, without reading anything (sc.8)', () => {
  const refused = (result: Awaited<ReturnType<typeof callLog>>) => {
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text.length).toBeGreaterThan(0);
    expect(runViews()).toHaveLength(0);
  };

  it('Given a dev whose PR is not followed (no delivery), When it asks for a log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await h.team('a');

    refused(await callLog(dev.id, 'ci'));
  });

  it('Given a red PR that turns out to come from a fork, When the dev asks for a log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await red();
    h.patchPr(1, { isCrossRepository: true });

    refused(await callLog(dev.id, 'ci'));
  });

  it('Given a request that fell (a foreign commit on the PR), When the dev asks for a log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    await h.until(request.id, ['watching']);
    h.setChecks(h.prHead(1), [{ ...failing('ci', 77), status: 'in_progress', conclusion: null }]);
    await h.waitFor(() => h.deliveryOf(request.id).ci?.checks.length === 1, 'no check was saved');
    h.pushToOrigin('feat/a', { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');
    await h.until(request.id, ['dropped']);

    refused(await callLog(team.dev.id, 'ci'));
  });

  it('Given a red PR, When the tester or another dev asks for the log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { tester } = await red('a');
    const other = await h.team('b');

    refused(await callLog(tester.id, 'ci'));
    refused(await callLog(other.dev.id, 'ci'));
  });

  it('Given a red PR, When the dev asks for a check that is not on the current head, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await red();

    refused(await callLog(dev.id, 'un-autre-check'));
  });

  it('Given a status of the forge with no job of Actions that is red, When the dev asks for its log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.setGhState({ statuses: { [head]: [{ context: 'deploy', state: 'failure' }] } });
    h.setChecks(head, [failing('ci', 77)]);
    await h.until(request.id, ['ci-red']);

    refused(await callLog(team.dev.id, 'deploy'));
  });

  it('Given no argument or a check that is not a text, When the dev calls the tool, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await red();
    const tool = toolsOf(dev.id).find((t) => t.name === 'get_ci_log');
    expect(tool).toBeDefined();

    refused(await tool?.call({}));
    refused(await tool?.call({ check: 7 }));
  });
});
