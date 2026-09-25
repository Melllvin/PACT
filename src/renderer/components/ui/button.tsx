import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui Button, with the variants of the interactive mockup (R17): outlined by default, cyan
// for the action, green to accept, tinted red to refuse (FR-040), and a light « contrast » button
// that starts something new.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-medium transition-[color,background-color,border-color,filter,transform] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 enabled:active:scale-[0.98] disabled:cursor-default disabled:opacity-45 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline:
          'border border-border bg-transparent text-foreground enabled:hover:border-white/16 enabled:hover:bg-white/3',
        primary: 'bg-primary text-[#061218] enabled:hover:brightness-110',
        accept: 'bg-accept text-[#06140b] enabled:hover:brightness-110',
        danger:
          'border border-destructive/30 bg-destructive/14 text-[#f2a0a0] enabled:hover:bg-destructive/24',
        contrast: 'bg-foreground text-background enabled:hover:bg-white',
        ghost: 'text-muted-foreground enabled:hover:bg-white/6 enabled:hover:text-foreground',
        link: 'px-0 text-primary underline underline-offset-3 hover:text-primary/80',
      },
      size: {
        sm: 'h-7 rounded-lg px-[11px] text-[12.5px]',
        md: 'h-9 rounded-[10px] px-3.5 text-[13px]',
        icon: 'size-[26px] rounded-[7px] text-[13px] font-normal',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
