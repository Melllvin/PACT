import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

/** An agent named in a dialog of a group (006). */
export type GroupMember = { id: string; name: string };

type Props = {
  name: string;
  branch: string;
  /** 006 FR-023 — the agents an orchestrator launched: they close with it, same worktree choice. */
  subAgents?: readonly GroupMember[];
  /** 008 US6 sc.6 — the delivery of this agent that is not over: `prNumber` is null before the PR. */
  delivery?: { prNumber: number | null } | undefined;
  onConfirm: (removeWorktree: boolean) => void;
  onCancel: () => void;
};

const CHOICE =
  'flex cursor-pointer gap-2.5 rounded-xl border border-white/8 px-3 py-2.5 transition-[background-color,border-color] duration-200 has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-primary/6';

/** FR-037: closing an agent asks whether its worktree and branch stay. Keeping is the default. */
export function CloseAgentDialog({
  name,
  branch,
  subAgents = [],
  delivery,
  onConfirm,
  onCancel,
}: Props) {
  const [remove, setRemove] = useState(false);
  const confirm = () => {
    onConfirm(remove);
  };

  const choice = (value: boolean, title: string, detail: string) => (
    <label className={CHOICE}>
      <RadioGroupItem value={String(value)} />
      <span className="flex flex-col gap-[3px]">
        <span className="text-[13.5px] font-medium">{title}</span>
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
          <MemberList
            members={subAgents}
            title="Se ferment avec lui, avec le même choix pour leur worktree :"
          />
          {delivery && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/8 px-3 py-2 text-[12.5px] leading-[1.4]">
              {delivery.prNumber === null
                ? 'Une livraison est en cours : elle sera abandonnée.'
                : `Une livraison est en cours (PR #${String(delivery.prNumber)}) : elle sera abandonnée, la PR restera ouverte.`}
            </p>
          )}
          <RadioGroup
            aria-label="Son worktree et sa branche"
            value={String(remove)}
            onValueChange={(value) => {
              setRemove(value === 'true');
            }}
          >
            {choice(false, 'Conserver', 'Le travail reste disponible dans le dépôt.')}
            {choice(
              true,
              'Supprimer',
              `Le worktree et la branche ${branch} sont effacés, modifications non commitées comprises.`,
            )}
          </RadioGroup>
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

function MemberList({ members, title }: { members: readonly GroupMember[]; title: string }) {
  if (members.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-0.5 font-mono text-[12.5px]">
        {members.map((member) => (
          <li key={member.id}>{member.name}</li>
        ))}
      </ul>
    </div>
  );
}

type RestartProps = {
  name: string;
  subAgents?: readonly GroupMember[];
  onConfirm: (resumeWork: boolean) => void;
  onCancel: () => void;
};

/**
 * 006 FR-025, FR-026: restarting a closed agent, with the agents closed with it. « Reprendre le
 * travail » is checked by default: those that were at work get a resume prompt.
 */
export function RestartGroupDialog({ name, subAgents = [], onConfirm, onCancel }: RestartProps) {
  const [resume, setResume] = useState(true);
  const confirm = () => {
    onConfirm(resume);
  };
  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(440px,calc(100vw-32px))]"
        onEnter={confirm}
      >
        <DialogBody className="gap-2.5 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Relancer {name}
          </DialogTitle>
          <MemberList members={subAgents} title="Repart avec lui, sur leurs worktrees :" />
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <Checkbox
              checked={resume}
              onCheckedChange={(value) => {
                setResume(value === true);
              }}
            />
            Reprendre le travail
          </label>
          <p className="text-[12px] leading-[1.4] text-muted-foreground">
            Les agents qui travaillaient à la fermeture reçoivent une consigne de reprise ; les
            autres attendent.
          </p>
        </DialogBody>
        <DialogFooter className="justify-end px-[18px]">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" size="md" onClick={confirm}>
            Relancer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
