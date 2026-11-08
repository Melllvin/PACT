/**
 * Tells a report handed in just before the `working` event of its own turn from a new turn: that
 * event must not drop the report, it carries it along. It remembers the last state seen of each
 * agent, to tell where a turn starts or ends.
 */
export class TurnTracker {
  /** Agents whose report came before the `working` event of the turn it belongs to. */
  private readonly lateWorking = new Set<string>();
  private readonly states = new Map<string, string>();

  /** A state event of an agent. True when it is the `working` of a turn whose report is in. */
  observe(agentId: string, state: string): boolean {
    const late = state === 'working' && this.lateWorking.delete(agentId);
    if (state === 'closed') this.forget(agentId);
    else this.states.set(agentId, state);
    return late;
  }

  /** A report was handed in by an agent in this state: is it ahead of its `working` event? */
  reported(agentId: string, state: string): void {
    if (state === 'working' && this.states.get(agentId) !== 'working') {
      this.lateWorking.add(agentId);
    }
  }

  /** The agent is closed: nothing of it is kept. */
  forget(agentId: string): void {
    this.lateWorking.delete(agentId);
    this.states.delete(agentId);
  }
}
