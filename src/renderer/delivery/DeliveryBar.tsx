import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// 008 contracts/ui.md — the thin bar at the bottom of the view of the workspace: the « Auto » switch
// of the project (FR-019) and the way to the settings of the delivery.

type Props = {
  /** `workspace.delivery.auto`. */
  auto: boolean;
  /** `workspace.hasOrigin`: without a remote, nothing is merged by PACT, so Auto is off and disabled. */
  hasOrigin: boolean;
  /** The NEW value the user asks for; the switch shows it only once the setting comes back. */
  onToggleAuto: (auto: boolean) => void;
  /** « Réglages de livraison »; absent, the button is not shown. */
  onOpenSettings?: (() => void) | undefined;
};

const WHAT_AUTO_DOES = 'Auto : fusionne quand la CI est verte';
const NO_REMOTE = 'Sans remote, la fusion reste confirmée par toi';

export function DeliveryBar({ auto, hasOrigin, onToggleAuto, onOpenSettings }: Props) {
  return (
    <footer
      aria-label="Livraison"
      className="flex shrink-0 items-center justify-end gap-3 border-t border-white/6 pt-2 text-[12.5px] text-muted-foreground"
    >
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        disabled={!hasOrigin}
        title={hasOrigin ? WHAT_AUTO_DOES : NO_REMOTE}
        onClick={() => {
          onToggleAuto(!auto);
        }}
        className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-45"
      >
        <span
          aria-hidden="true"
          className={`relative h-4 w-7 rounded-full border transition-colors motion-reduce:transition-none ${
            auto ? 'border-accept/40 bg-accept/30' : 'border-border bg-white/5'
          }`}
        >
          <span
            className={`absolute top-0.5 size-2.5 rounded-full transition-[left] motion-reduce:transition-none ${
              auto ? 'left-[14px] bg-accept' : 'left-0.5 bg-muted-foreground'
            }`}
          />
        </span>
        Auto
      </button>
      {onOpenSettings && (
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          <Settings2 aria-hidden="true" />
          Réglages de livraison
        </Button>
      )}
    </footer>
  );
}
