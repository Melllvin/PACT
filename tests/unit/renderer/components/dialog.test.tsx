import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../../src/renderer/components/ui/dialog';
import { CloseAgentDialog } from '../../../../src/renderer/tiles/CloseAgentDialog';
import { LogPanel } from '../../../../src/renderer/tiles/LogPanel';

// T155 — the shadcn Dialog: Radix warns on the console when a dialog has no title or a dangling
// description; none of ours may.

const errors = vi.spyOn(console, 'error');
const warnings = vi.spyOn(console, 'warn');
afterEach(() => {
  errors.mockClear();
  warnings.mockClear();
});

describe('Dialog', () => {
  it.each([
    [
      'the close dialog',
      <CloseAgentDialog
        name="Claude Code 1"
        branch="main"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    ],
    ['the log', <LogPanel name="Claude Code 1" text="" onClose={vi.fn()} />],
  ])('opens %s without any console error nor warning', (_, dialog) => {
    render(dialog);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('confirms with Enter, except on a button, which acts itself', async () => {
    const onEnter = vi.fn();
    render(
      <Dialog open>
        <DialogContent onEnter={onEnter}>
          <DialogBody>
            <DialogTitle>Titre</DialogTitle>
            <DialogDescription>Détail</DialogDescription>
            <input aria-label="Champ" />
            <button>Bouton</button>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole('textbox', { name: 'Champ' }));
    await userEvent.keyboard('{Enter}');
    expect(onEnter).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'Bouton' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('a');
    expect(onEnter).toHaveBeenCalledOnce();
  });
});
