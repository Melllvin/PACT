import { useState } from 'react';
import { usageThresholdsSchema, type UsageThresholds as Thresholds } from '../../shared/usage';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

// 005 FR-010 — the two alert thresholds of the gauges: orange at the first, red at the second.

type Props = {
  thresholds: Thresholds;
  onSave: (thresholds: Thresholds) => void;
};

const CONTROL =
  'w-20 rounded-[10px] border border-white/8 bg-white/2 px-[9px] py-1.5 text-[12.5px] text-foreground';

export function UsageThresholds({ thresholds, onSave }: Props) {
  const [warn, setWarn] = useState(String(thresholds.warn));
  const [critical, setCritical] = useState(String(thresholds.critical));
  const parsed = usageThresholdsSchema.safeParse({
    warn: Number(warn),
    critical: Number(critical),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) onSave(parsed.data);
      }}
    >
      <label className="flex items-center gap-2.5 text-[12.5px]">
        <span className="flex-1">Premier seuil (orange)</span>
        <input
          type="number"
          min={1}
          max={99}
          value={warn}
          onChange={(event) => {
            setWarn(event.target.value);
          }}
          className={CONTROL}
        />
        %
      </label>
      <label className="flex items-center gap-2.5 text-[12.5px]">
        <span className="flex-1">Second seuil (rouge)</span>
        <input
          type="number"
          min={2}
          max={100}
          value={critical}
          onChange={(event) => {
            setCritical(event.target.value);
          }}
          className={CONTROL}
        />
        %
      </label>
      {!parsed.success && (
        <p role="alert" className="m-0 text-[12px] text-destructive">
          Deux nombres entiers, le premier de 1 à 99, plus petit que le second (au plus 100).
        </p>
      )}
      <Button type="submit" variant="contrast" disabled={!parsed.success}>
        Enregistrer
      </Button>
    </form>
  );
}

export function UsageThresholdsDialog({
  onClose,
  onSave,
  ...props
}: Props & { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[min(420px,calc(100vw-32px))]">
        <DialogBody className="gap-3 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Seuils d’alerte
          </DialogTitle>
          <UsageThresholds
            {...props}
            onSave={(thresholds) => {
              onSave(thresholds);
              onClose();
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
