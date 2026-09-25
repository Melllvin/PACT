import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

type Props = {
  name: string;
  branch: string;
  onConfirm: (removeWorktree: boolean) => void;
  onCancel: () => void;
};

const CHOICE =
  'flex cursor-pointer gap-2.5 rounded-[7px] border border-white/8 px-3 py-2.5 has-checked:border-primary has-checked:bg-primary/8 has-focus-visible:ring-2 has-focus-visible:ring-ring/60';

/** FR-037: closing an agent asks whether its worktree and branch stay. Keeping is the default. */
export function CloseAgentDialog({ name, branch, onConfirm, onCancel }: Props) {
  const [remove, setRemove] = useState(false);
  const confirm = () => {
    onConfirm(remove);
  };

  const choice = (value: boolean, title: string, detail: string) => (
    <label className={CHOICE}>
      <input
        type="radio"
        name="worktree"
        className="sr-only"
        checked={remove === value}
        onChange={() => {
          setRemove(value);
        }}
      />
      <span aria-hidden className="text-[14px] text-muted-foreground">
        {remove === value ? '◉' : '○'}
      </span>
      <span className="flex flex-col gap-[3px]">
        <span className="text-[13.5px] font-semibold">{title}</span>
        <span className="text-[12px] leading-[1.4] text-muted-foreground">{detail}</span>
      </span>
    </label>
  );

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(440px,calc(100vw-32px))]"
        onEnter={confirm}
      >
        <DialogBody className="gap-2.5 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Fermer {name}
          </DialogTitle>
          <div role="radiogroup" aria-label="Son worktree et sa branche" className="contents">
            {choice(false, 'Conserver', 'Le travail reste disponible dans le dépôt.')}
            {choice(
              true,
              'Supprimer',
              `Le worktree et la branche ${branch} sont effacés, modifications non commitées comprises.`,
            )}
          </div>
        </DialogBody>
        <DialogFooter className="justify-end px-[18px]">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" size="md" onClick={confirm}>
            Fermer l’agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
