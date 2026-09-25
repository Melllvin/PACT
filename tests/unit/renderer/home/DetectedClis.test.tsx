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
        onAdd={vi.fn()}
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
        onAdd={vi.fn()}
      />,
    );
    expect(item('Codex').textContent).toMatch(/0\.40\.0.*mettez-le à jour/);
  });

  it('tells how to approve the PACT hooks in Codex', () => {
    render(
      <DetectedClis
        clis={[cli({ id: 'codex', name: 'Codex', adapter: 'codex', version: '0.156.1' })]}
        onRedetect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(within(item('Codex')).getByText(/Trust all/)).toBeDefined();
  });

  it('detects again on request', async () => {
    const user = userEvent.setup();
    const onRedetect = vi.fn();
    render(<DetectedClis clis={[]} onRedetect={onRedetect} onAdd={vi.fn()} />);
    expect(screen.getByText(/Aucun CLI d’agent détecté/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Détecter à nouveau' }));
    expect(onRedetect).toHaveBeenCalled();
  });

  it('warns when the command of a CLI added by hand is not found (US6 scenario 6)', () => {
    render(
      <DetectedClis
        clis={[
          cli({
            id: 'custom-goose',
            name: 'Goose',
            adapter: 'generic',
            command: 'goose',
            origin: 'custom',
            status: 'missing',
            resolvedPath: null,
            version: null,
          }),
        ]}
        onRedetect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(item('Goose').textContent).toMatch(/commande « goose » introuvable/);
  });

  it('adds another CLI from its name and command', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(() => Promise.resolve(null));
    render(<DetectedClis clis={[]} onRedetect={vi.fn()} onAdd={onAdd} />);
    await user.click(screen.getByRole('button', { name: 'Autre CLI — ajouter' }));
    const dialog = screen.getByRole('dialog', { name: 'Ajouter un CLI' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nom' }), 'Aider');
    await user.type(within(dialog).getByRole('textbox', { name: 'Commande' }), 'aider --no-git');
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }));
    expect(onAdd).toHaveBeenCalledWith('Aider', 'aider --no-git');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the dialog open with the reason when the CLI is refused', async () => {
    const user = userEvent.setup();
    render(
      <DetectedClis clis={[]} onRedetect={vi.fn()} onAdd={() => Promise.resolve('Nom requis.')} />,
    );
    await user.click(screen.getByRole('button', { name: 'Autre CLI — ajouter' }));
    const dialog = screen.getByRole('dialog', { name: 'Ajouter un CLI' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nom' }), 'x');
    await user.type(within(dialog).getByRole('textbox', { name: 'Commande' }), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Nom requis.');
  });
});
