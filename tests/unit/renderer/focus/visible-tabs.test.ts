import { describe, expect, it } from 'vitest';
import { visibleTabs } from '../../../../src/renderer/focus/visible-tabs';
import { agent } from '../tiles/fixtures';

// 006 T044 (#43) — a Focus tab shows only when it has something to show; Terminal always does.
// Assumed API: `visibleTabs(agent, content): FocusTab[]`, in the order of the tab bar, with
// `content = { served: boolean; changedFiles: number; actions: number; reports: number;
// conflicts?: number }` — what the agent has to show now. `served`: the agent's port is served.

const none = { served: false, changedFiles: 0, actions: 0, reports: 0 };
const lead = agent(1, { role: 'orchestrator' });
const plain = agent(2);

describe('visibleTabs (#43)', () => {
  it('Given nothing to show, When the tabs are asked, Then only Terminal is there', () => {
    expect(visibleTabs(plain, none)).toEqual(['terminal']);
    expect(visibleTabs(lead, none)).toEqual(['terminal']);
  });

  it('Given a served port, When asked, Then Aperçu is there, and only then', () => {
    expect(visibleTabs(plain, { ...none, served: true })).toEqual(['terminal', 'preview']);
    expect(visibleTabs(plain, none)).not.toContain('preview');
  });

  it('Given a non-empty diff, When asked, Then Changements is there, and not with an empty one', () => {
    expect(visibleTabs(plain, { ...none, changedFiles: 2 })).toEqual(['terminal', 'changes']);
    expect(visibleTabs(plain, { ...none, changedFiles: 0 })).not.toContain('changes');
  });

  it('Given journal entries, When asked for the orchestrator, Then Actions is there, and not without entries', () => {
    expect(visibleTabs(lead, { ...none, actions: 1 })).toEqual(['terminal', 'actions']);
    expect(visibleTabs(lead, { ...none, actions: 0 })).not.toContain('actions');
  });

  it('Given reports, When asked for the orchestrator, Then Rapports is there, and not without reports', () => {
    expect(visibleTabs(lead, { ...none, reports: 3 })).toEqual(['terminal', 'reports']);
    expect(visibleTabs(lead, { ...none, reports: 0 })).not.toContain('reports');
  });

  it('Given everything to show, When asked, Then the tabs are in the order of the bar', () => {
    const all = { served: true, changedFiles: 1, actions: 1, reports: 1 };
    expect(visibleTabs(lead, all)).toEqual([
      'terminal',
      'preview',
      'changes',
      'actions',
      'reports',
    ]);
  });

  it('Given content that arrives, When asked again, Then the tab appears without anything else (no reload)', () => {
    const before = visibleTabs(plain, none);
    const after = visibleTabs(plain, { ...none, changedFiles: 1 });
    expect(before).not.toContain('changes');
    expect(after).toContain('changes');
  });
});
