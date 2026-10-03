import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../src/renderer/components/ui/dropdown-menu';

// 002 T001 — the « Squash en 1 commit ▾ » and « Ouvrir dans l'éditeur ▾ » menus (research R10).
const menu = (onSelect = vi.fn()) =>
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Squash en 1 commit ▾</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelect}>Garder les commits</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );

describe('DropdownMenu', () => {
  it('opens a menu from the keyboard and runs the chosen item', async () => {
    const onSelect = vi.fn();
    menu(onSelect);
    const trigger = screen.getByRole('button', { name: 'Squash en 1 commit ▾' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeDefined();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Garder les commits' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('closes on Escape and gives the focus back to its trigger', async () => {
    menu();
    const trigger = screen.getByRole('button', { name: 'Squash en 1 commit ▾' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
