import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../../../../src/renderer/components/ui/button';

// T159 — the buttons of the interactive mockup: cyan stays the action color (FR-040), the light
// « contrast » button starts something new (« Lancer », « Choisir un dépôt Git… »).
describe('Button', () => {
  it('keeps cyan for the actions', () => {
    render(<Button variant="primary">Reprendre</Button>);
    expect(screen.getByRole('button', { name: 'Reprendre' }).className).toMatch(/bg-primary/);
  });

  it('offers a light button on the dark background to start something', () => {
    render(<Button variant="contrast">Lancer</Button>);
    expect(screen.getByRole('button', { name: 'Lancer' }).className).toMatch(/bg-foreground/);
  });
});
