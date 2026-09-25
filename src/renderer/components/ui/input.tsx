import * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui Input on the 1c fields: sunken background, 5px radius, cyan border on focus.
function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'w-full min-w-0 rounded-[5px] border border-border bg-[#0a0d12] px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary read-only:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
