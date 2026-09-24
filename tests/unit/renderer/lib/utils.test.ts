import { describe, expect, it } from 'vitest';
import { cn } from '../../../../src/renderer/lib/utils';

// research.md R16 — class names of the shadcn/ui components.
describe('cn', () => {
  it('joins the classes that apply and drops the others', () => {
    expect(cn('flex', false, undefined, null, 'gap-2', { hidden: false, block: true })).toBe(
      'flex gap-2 block',
    );
  });

  it('lets a later Tailwind class override a conflicting one', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });
});
