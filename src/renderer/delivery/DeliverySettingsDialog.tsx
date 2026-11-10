import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  MAX_POLISH,
  MAX_POLISH_BRIEF,
  MAX_ROUNDS_LIMIT,
  type DeliverySettings,
  type MergeMode,
} from '../../shared/delivery';

// 008 contracts/ui.md « Réglages de livraison » — the mode of merge, the ceiling of round trips, the polish
// passes and their brief. Saved explicitly; a value out of bounds is refused with the message of its field.
// `auto` is the switch of the bar, not a field of this dialog.

export type DeliveryFormSettings = Pick<
  DeliverySettings,
  'mergeMode' | 'maxRounds' | 'polishPasses' | 'polishBrief'
>;

type Props = {
  settings: DeliveryFormSettings;
  onSave: (settings: DeliveryFormSettings) => void;
  onCancel: () => void;
};

const MODES: { value: MergeMode; title: string; detail: string }[] = [
  { value: 'squash', title: 'Squash', detail: 'Un seul commit sur la branche principale.' },
  { value: 'merge', title: 'Merge commit', detail: 'L’historique de la branche est gardé.' },
  { value: 'rebase', title: 'Rebase', detail: 'Les commits sont rejoués, sans commit de fusion.' },
];

const CHOICE =
  'flex cursor-pointer gap-2.5 rounded-xl border border-white/8 px-3 py-2.5 transition-[background-color,border-color] duration-200 has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-primary/6';

/** A whole number in `min`–`max`, from the text of a field; `null` when it is not one. */
const wholeIn = (text: string, min: number, max: number): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

type Errors = Partial<Record<'rounds' | 'passes' | 'brief', string>>;

export function DeliverySettingsDialog({ settings, onSave, onCancel }: Props) {
  const [mergeMode, setMergeMode] = useState<MergeMode>(settings.mergeMode);
  const [rounds, setRounds] = useState(String(settings.maxRounds));
  const [passes, setPasses] = useState(String(settings.polishPasses));
  const [brief, setBrief] = useState(settings.polishBrief);
  const [errors, setErrors] = useState<Errors>({});
  const ids = { rounds: useId(), passes: useId(), brief: useId() };

  const save = () => {
    const maxRounds = wholeIn(rounds, 1, MAX_ROUNDS_LIMIT);
    const polishPasses = wholeIn(passes, 0, MAX_POLISH);
    const found: Errors = {};
    if (maxRounds === null) found.rounds = `Un nombre entier de 1 à ${String(MAX_ROUNDS_LIMIT)}.`;
    if (polishPasses === null) found.passes = `Un nombre entier de 0 à ${String(MAX_POLISH)}.`;
    if (brief.length > MAX_POLISH_BRIEF) {
      found.brief = `${String(MAX_POLISH_BRIEF)} caractères au plus.`;
    }
    setErrors(found);
    if (maxRounds === null || polishPasses === null || found.brief) return;
    onSave({ mergeMode, maxRounds, polishPasses, polishBrief: brief });
  };

  const field = (key: keyof Errors) => ({
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `${ids[key]}-error` : undefined,
  });
  const message = (key: keyof Errors) =>
    errors[key] && (
      <p id={`${ids[key]}-error`} role="alert" className="text-[12px] text-destructive">
        {errors[key]}
      </p>
    );

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent aria-describedby={undefined} className="w-[min(480px,calc(100vw-32px))]">
        <DialogBody className="gap-3 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Réglages de livraison
          </DialogTitle>
          <RadioGroup
            aria-label="Mode de fusion"
            value={mergeMode}
            onValueChange={(value) => {
              setMergeMode(value as MergeMode);
            }}
          >
            {MODES.map(({ value, title, detail }) => (
              <label key={value} className={CHOICE}>
                <RadioGroupItem value={value} />
                <span className="flex flex-col gap-[3px]">
                  <span className="text-[13.5px] font-medium">{title}</span>
                  <span className="text-[12px] leading-[1.4] text-muted-foreground">{detail}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.rounds} className="text-[13px]">
              Plafond d’allers-retours
            </label>
            <Input
              id={ids.rounds}
              type="number"
              min={1}
              max={MAX_ROUNDS_LIMIT}
              value={rounds}
              onChange={(event) => {
                setRounds(event.target.value);
              }}
              {...field('rounds')}
            />
            {message('rounds')}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.passes} className="text-[13px]">
              Passes de peaufinage
            </label>
            <Input
              id={ids.passes}
              type="number"
              min={0}
              max={MAX_POLISH}
              value={passes}
              onChange={(event) => {
                setPasses(event.target.value);
              }}
              {...field('passes')}
            />
            {message('passes')}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.brief} className="text-[13px]">
              Consigne de peaufinage
            </label>
            <textarea
              id={ids.brief}
              rows={4}
              maxLength={MAX_POLISH_BRIEF}
              value={brief}
              onChange={(event) => {
                setBrief(event.target.value);
              }}
              className="w-full rounded-[10px] border border-white/8 bg-white/2 px-3 py-2 text-[13px] text-foreground outline-none focus-visible:border-primary/50"
              {...field('brief')}
            />
            {message('brief')}
          </div>
        </DialogBody>
        <DialogFooter className="justify-end px-[18px]">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" size="md" onClick={save}>
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
