import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// shadcn/ui Dialog as in the interactive mockup (R17): blurred backdrop, raised card, 18px radius,
// coming in from slightly below and out of focus.

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/**
 * `onEnter`: Enter confirms the default choice from anywhere in the dialog but a button, which
 * acts itself (« Entrée = choix par défaut », 1m).
 */
function DialogContent({
  className,
  children,
  onEnter,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { onEnter?: () => void }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-[rgb(5_5_7/60%)] backdrop-blur-[6px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[min(380px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[18px] border border-white/8 bg-raised text-foreground shadow-[0_40px_100px_rgb(0_0_0/60%)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=open]:slide-in-from-bottom-3 data-[state=open]:blur-in-[6px] data-[state=open]:duration-[420ms] data-[state=open]:ease-out-soft motion-reduce:animate-none',
          className,
        )}
        onKeyDown={
          onEnter &&
          ((event) => {
            if (event.key !== 'Enter' || event.target instanceof HTMLButtonElement) return;
            event.preventDefault();
            onEnter();
          })
        }
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-[18px]', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex items-center gap-2 border-t border-white/6 px-6 pt-3.5 pb-5', className)}
      {...props}
    />
  );
}

/** The title of the interactive mockup's dialogs: plain, medium, slightly tightened. */
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('m-0 text-[18px] font-medium tracking-[-0.02em] text-foreground', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('m-0 text-[13px] text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle };
