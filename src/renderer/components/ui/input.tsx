import * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui Input as in the interactive mockup: faint fill, 10px radius, cyan border on focus.
function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-[10px] border border-white/8 bg-white/2 px-3 text-[13px] text-foreground transition-[border-color] duration-200 outline-none placeholder:text-[#5c5c64] focus-visible:border-primary/50 read-only:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
