import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Fails on any axe violation of impact `serious` or `critical` (006 NFR accessibilité). */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .setLegacyMode()
    // The tab bar nests close buttons in its tablist (defect predating 006): out of this audit.
    .exclude('[role="tablist"]')
    .analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact ?? '?'} ${v.id}: ${v.help} (${String(v.nodes.length)} nœud(s))`);
  expect(blocking, blocking.join('\n')).toEqual([]);
}
