import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Props = {
  /** The sandboxed renderer cannot read file paths: the preload resolves them (webUtils). */
  getPathForFile: (file: File) => string;
  onDropPath: (path: string) => void;
  onPick: () => void;
  onClone: () => void;
};

export function DropZone({ getPathForFile, onDropPath, onPick, onClone }: Props) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2.5 rounded-[10px] border-[1.5px] border-dashed border-border bg-[rgb(13_17_23/70%)] px-[18px] py-[22px] text-center transition-colors',
        over && 'border-primary',
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onDropPath(getPathForFile(file));
      }}
    >
      <h3 className="m-0 text-[14px] font-semibold">Autre dépôt</h3>
      <p className="m-0 text-[12.5px] text-muted-foreground">Déposez un dossier Git ici</p>
      <p className="m-0 font-mono text-[11px] text-muted-foreground">ou</p>
      <Button variant="primary" size="md" onClick={onPick}>
        Choisir un dépôt Git…
      </Button>
      <Button size="md" onClick={onClone}>
        Cloner depuis une URL…
      </Button>
    </div>
  );
}
