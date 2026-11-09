import { useState } from 'react';
import { usageThresholdsSchema, type UsageThresholds as Thresholds } from '../../shared/usage';
import {
  MAX_STOP,
  MIN_STOP,
  stopOf,
  usageStopsSchema,
  type UsageStops,
} from '../../shared/usage-limit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

// 005 FR-010 — the two alert thresholds of the gauges: orange at the first, red at the second.

/** 009 US4 — the « Arrêt » section: a threshold per CLI and per window. */
export type StopSettings = {
  stops: UsageStops;
  clis: { cliId: string; name: string; windows: { id: string; label?: string }[] }[];
  onSave: (stops: UsageStops) => void;
};

type Props = {
  thresholds: Thresholds;
  onSave: (thresholds: Thresholds) => void;
  stopSettings?: StopSettings;
};

const CONTROL =
  'w-20 rounded-[10px] border border-white/8 bg-white/2 px-[9px] py-1.5 text-[12.5px] text-foreground';

export function UsageThresholds({ thresholds, onSave, stopSettings }: Props) {
  const [warn, setWarn] = useState(String(thresholds.warn));
  const [critical, setCritical] = useState(String(thresholds.critical));
  const parsed = usageThresholdsSchema.safeParse({
    warn: Number(warn),
    critical: Number(critical),
  });
  return (
    <div className="flex flex-col gap-4">
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
      {stopSettings && <StopSection settings={stopSettings} critical={thresholds.critical} />}
    </div>
  );
}

const fieldKey = (cliId: string, windowId: string) => `${cliId}\u0000${windowId}`;

function StopSection({ settings, critical }: { settings: StopSettings; critical: number }) {
  const { stops, clis, onSave } = settings;
  const [edited, setEdited] = useState<Record<string, string>>({});
  const valueOf = (cliId: string, windowId: string) =>
    edited[fieldKey(cliId, windowId)] ?? String(stopOf(stops, cliId, windowId));
  const next: UsageStops = { ...stops };
  for (const { cliId, windows } of clis) {
    next[cliId] = {
      ...stops[cliId],
      ...Object.fromEntries(windows.map((w) => [w.id, Number(valueOf(cliId, w.id))])),
    };
  }
  const parsed = usageStopsSchema.safeParse(next);
  const shown = parsed.success
    ? clis.flatMap(({ cliId, windows }) => windows.map((w) => stopOf(parsed.data, cliId, w.id)))
    : [];
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) onSave(parsed.data);
      }}
    >
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 p-0 text-[12.5px] font-semibold">Arrêt</legend>
        {clis.map(({ cliId, name, windows }) => (
          <fieldset key={cliId} className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-[12px] text-muted-foreground">{name}</legend>
            {windows.map((w) => (
              <label key={w.id} className="flex items-center gap-2.5 text-[12.5px]">
                <span className="flex-1">{w.label ?? w.id} : arrêt à</span>
                <input
                  type="number"
                  min={MIN_STOP}
                  max={MAX_STOP}
                  value={valueOf(cliId, w.id)}
                  onChange={(event) => {
                    setEdited({ ...edited, [fieldKey(cliId, w.id)]: event.target.value });
                  }}
                  className={CONTROL}
                />
                %
              </label>
            ))}
          </fieldset>
        ))}
        <p className="m-0 text-[12px] text-muted-foreground">Sauvegarde demandée 3 points avant.</p>
        {shown.includes(MAX_STOP) && (
          <p className="m-0 text-[12px] text-muted-foreground">
            À 100 %, PACT n’arrête plus avant une erreur de limite.
          </p>
        )}
        {shown.some((stop) => stop < critical) && (
          <p className="m-0 text-[12px] text-muted-foreground">
            {`PACT arrête avant le niveau critique (${String(critical)} %) : la jauge ne passera plus au rouge pour ses agents.`}
          </p>
        )}
        {!parsed.success && (
          <p role="alert" className="m-0 text-[12px] text-destructive">
            Entre 10 et 100 %
          </p>
        )}
        <Button type="submit" variant="contrast" disabled={!parsed.success}>
          Enregistrer
        </Button>
      </fieldset>
    </form>
  );
}

export function UsageThresholdsDialog({
  onClose,
  onSave,
  stopSettings,
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
            {...(stopSettings && {
              stopSettings: {
                ...stopSettings,
                onSave: (stops: UsageStops) => {
                  stopSettings.onSave(stops);
                  onClose();
                },
              },
            })}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
