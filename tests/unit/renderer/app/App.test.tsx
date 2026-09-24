import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from '../../../../src/renderer/app/App';

it('renders the PACT shell', () => {
  render(<App />);
  expect(screen.getByRole('heading', { level: 1, name: 'PACT' })).toBeDefined();
});
