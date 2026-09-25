import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui Button, with the variants of the 1c mockups: outlined by default, solid for the
// action (cyan), accept (green) and refuse or error (red) colors (FR-040).
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] font-semibold transition-[color,background-color,border-color,opacity] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline: 'border border-border bg-transparent text-foreground hover:bg-white/5',
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        accept: 'bg-accept text-[#0b1a0f] hover:bg-accept/90',
        danger: 'bg-destructive text-white hover:bg-destructive/90',
        ghost: 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
        link: 'px-0 text-primary underline underline-offset-3 hover:text-primary/80',
      },
      size: {
        sm: 'px-[9px] py-[3px] text-[12px]',
        md: 'px-3 py-[5px] text-[12.5px]',
        icon: 'size-6 rounded-[4px] text-[13px] font-normal',
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
