import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-[9px] px-[5px] font-mono text-[10.5px] font-medium whitespace-nowrap transition-[background-color,color] duration-300',
  {
    variants: {
      variant: {
        muted: 'bg-white/10 text-[#a1a1aa]',
        waiting: 'bg-waiting text-[#1a1206]',
        primary: 'bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { variant: 'muted' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
