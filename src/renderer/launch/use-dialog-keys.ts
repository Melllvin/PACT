import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Escape and Enter for the launch dialogs, wherever the focus is. Enter on a button is left to
 * the button itself, so a choice is never confirmed twice.
 */
export function useDialogKeys({
  onEscape,
  onEnter,
}: {
  onEscape: () => void;
  onEnter?: () => void;
}) {
  const handlers = useRef({ onEscape, onEnter });
  useLayoutEffect(() => {
    handlers.current = { onEscape, onEnter };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handlers.current.onEscape();
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        handlers.current.onEnter?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
