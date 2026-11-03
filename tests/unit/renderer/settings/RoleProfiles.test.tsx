import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RoleProfiles } from '../../../../src/renderer/settings/RoleProfiles';
import type { CliDefinition, Role, RoleProfile } from '../../../../src/shared/model';

// 004 T011 — the role profiles of a workspace: editing, the test < dev warning, a CLI no longer
// installed (FR-002 to FR-004).

const claude: CliDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  adapter: 'claude-code',
  command: 'claude',
  resolvedPath: '/bin/claude',
  version: '2.1.0',
  origin: 'detected',
  status: 'installed',
  models: ['haiku', 'sonnet', 'opus'],
  modelTiers: [['haiku'], ['sonnet'], ['opus']],
  supportsEffort: true,
};
const codex: CliDefinition = {
  ...claude,
  id: 'codex',
  name: 'Codex',
  adapter: 'codex',
  command: 'codex',
  status: 'missing',
  models: [],
  modelTiers: [],
};

type Stored = Partial<Record<Role, RoleProfile>>;

const setup = (stored: Stored = {}) => {
  const onChange = vi.fn<(profiles: Stored) => void>();
  render(<RoleProfiles clis={[claude, codex]} stored={stored} onChange={onChange} />);
  return { user: userEvent.setup(), onChange };
};

const row = (name: string) => screen.getByRole('row', { name });
const select = (role: string, field: string) =>
  within(row(role)).getByRole('combobox', { name: `${field} · ${role}` });
const value = (role: string, field: string) => (select(role, field) as HTMLSelectElement).value;

describe('RoleProfiles', () => {
  it('shows the default profile of each role', () => {
    setup();
    expect(value('Orchestrateur', 'Modèle')).toBe('opus');
    expect(value('Dev', 'Modèle')).toBe('sonnet');
    expect(value('Test', 'Modèle')).toBe('sonnet');
    expect(value('Recap', 'Modèle')).toBe('haiku');
    expect(value('Dev', 'Plafond')).toBe('opus');
  });

  it('saves the profile changed, the others staying defaults', async () => {
    const { user, onChange } = setup();
    await user.selectOptions(select('Dev', 'Modèle'), 'haiku');
    await user.selectOptions(select('Dev', 'Effort'), 'high');
    expect(onChange).toHaveBeenLastCalledWith({
      dev: {
        cliId: 'claude-code',
        model: 'haiku',
        effort: 'high',
        maxModel: 'opus',
        escalate: false,
      },
    });
  });

  it('warns, without blocking, when the test is weaker than the dev', () => {
    setup({
      test: {
        cliId: 'claude-code',
        model: 'haiku',
        effort: null,
        maxModel: 'opus',
        escalate: false,
      },
    });
    expect(screen.getByRole('status').textContent).toContain(
      'Le profil test (haiku) est plus faible que le profil dev (sonnet).',
    );
  });

  it('flags a CLI no longer installed and goes back to the default profile', async () => {
    const { user, onChange } = setup({
      spec: { cliId: 'codex', model: null, effort: null, maxModel: null, escalate: false },
    });
    expect(within(row('Spec')).getByText('Codex n’est pas installé')).toBeDefined();
    await user.click(
      within(row('Spec')).getByRole('button', { name: 'Revenir au profil par défaut' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
