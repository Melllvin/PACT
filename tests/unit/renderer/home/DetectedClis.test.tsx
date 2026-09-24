import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DetectedClis } from '../../../../src/renderer/home/DetectedClis';
import type { CliDefinition } from '../../../../src/shared/model';

// T067 — « Agents détectés » on the home tab (FR-007).

const cli = (overrides: Partial<CliDefinition>): CliDefinition => ({
  id: 'claude-code',
  name: 'Claude Code',
  adapter: 'claude-code',
  command: 'claude',
  resolvedPath: '/bin/claude',
  version: '2.1.281',
  origin: 'detected',
  status: 'installed',
  models: [],
  ...overrides,
});

const item = (name: string) => screen.getByRole('listitem', { name });

describe('DetectedClis', () => {
  it('marks installed CLIs with their version, and absent ones', () => {
    render(
      <DetectedClis
        clis={[
          cli({}),
          cli({
            id: 'codex',
            name: 'Codex',
            adapter: 'codex',
            status: 'missing',
            resolvedPath: null,
            version: null,
          }),
        ]}
        onRedetect={vi.fn()}
      />,
    );
    expect(item('Claude Code').textContent).toMatch(/✓.*2\.1\.281/);
    expect(item('Codex').textContent).toMatch(/○.*absent/);
  });

  it('invites to update a CLI too old for PACT', () => {
    render(
      <DetectedClis
        clis={[
          cli({
            id: 'codex',
            name: 'Codex',
            adapter: 'codex',
            status: 'unsupported-version',
            version: '0.40.0',
          }),
        ]}
        onRedetect={vi.fn()}
      />,
    );
    expect(item('Codex').textContent).toMatch(/0\.40\.0.*mettez-le à jour/);
  });

  it('tells how to approve the PACT hooks in Codex', () => {
    render(
      <DetectedClis
        clis={[cli({ id: 'codex', name: 'Codex', adapter: 'codex', version: '0.156.1' })]}
        onRedetect={vi.fn()}
      />,
    );
    expect(within(item('Codex')).getByText(/Trust all/)).toBeDefined();
  });

  it('detects again on request', async () => {
    const user = userEvent.setup();
    const onRedetect = vi.fn();
    render(<DetectedClis clis={[]} onRedetect={onRedetect} />);
    expect(screen.getByText(/Aucun CLI d’agent détecté/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Détecter à nouveau' }));
    expect(onRedetect).toHaveBeenCalled();
  });
});
