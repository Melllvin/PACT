import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Toggle as TogglePrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

const toggleVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap outline-none transition-[background-color,border-color,color] duration-250 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:text-[#4a4a52]',
  {
    variants: {
      variant: {
        /** A tab of a segmented control (Vues, R17). */
        segment:
          'h-[26px] rounded-[7px] px-2.5 text-[12.5px] text-muted-foreground enabled:hover:text-foreground data-[state=on]:bg-white/8 data-[state=on]:text-foreground',
        /** A compact choice inside a bordered strip (permissions). */
        strip:
          'px-[9px] py-[3px] text-[11.5px] font-medium text-muted-foreground not-first:border-l not-first:border-white/8 data-[state=on]:bg-white/8 data-[state=on]:text-foreground',
        outline:
          'h-8 rounded-[9px] border border-white/7 px-3 text-[12.5px] text-foreground hover:border-white/14 data-[state=on]:bg-white/5',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

function Toggle({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
