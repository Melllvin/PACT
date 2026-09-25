import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Props = {
  onPickDestination: () => Promise<string | null>;
  onClone: (url: string, destination: string) => void;
  onCancel: () => void;
};

const FIELD = 'flex flex-col gap-1 text-[12px] text-muted-foreground';

/** « Cloner depuis une URL… »: URL and destination folder, then the clone runs in the main process. */
export function CloneDialog({ onPickDestination, onClone, onCancel }: Props) {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const ready = url.trim() !== '' && destination !== '';

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent aria-describedby={undefined} className="w-[min(440px,calc(100vw-32px))]">
        <DialogBody>
          <DialogTitle>Cloner un dépôt</DialogTitle>
          <label className={FIELD}>
            URL du dépôt
            <Input
              className="font-mono"
              value={url}
              placeholder="git@github.com:equipe/depot.git"
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
          </label>
          <div className="flex items-end gap-2">
            <label className={`${FIELD} flex-1`}>
              Destination
              <Input className="font-mono" value={destination} readOnly />
            </label>
            <Button
              size="md"
              onClick={() => {
                void onPickDestination().then((picked) => {
                  if (picked) setDestination(picked);
                });
              }}
            >
              Choisir…
            </Button>
          </div>
        </DialogBody>
        <DialogFooter className="justify-end">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Annuler
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!ready}
            onClick={() => {
              onClone(url.trim(), destination);
            }}
          >
            Cloner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
