import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

type Props = { name: string; text: string; onClose: () => void };

/* eslint-disable no-control-regex -- terminal escape sequences are control characters */
const ESCAPES = [
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, // OSC: titles, links
  /\u001b\[[0-?]*[ -/]*[@-~]/g, // CSI: colors, cursor
  /\u001b[@-_]/g, // other two-character sequences
];
/* eslint-enable no-control-regex */

/** The raw output as plain text: escape sequences dropped, line endings made plain. */
const plain = (text: string) =>
  ESCAPES.reduce((out, pattern) => out.replace(pattern, ''), text).replace(/\r\n?/g, '\n');

/** « Journal »: everything the agent printed, kept by the main process across restarts. */
export function LogPanel({ name, text, onClose }: Props) {
  const output = plain(text);
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent aria-describedby={undefined} className="w-[min(760px,calc(100vw-32px))]">
        <DialogBody>
          <DialogTitle>Journal de {name}</DialogTitle>
          {output ? (
            <pre className="m-0 max-h-[60vh] overflow-auto rounded-[10px] border border-white/6 bg-surface p-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap">
              {output}
            </pre>
          ) : (
            <p className="m-0 text-[12.5px] text-muted-foreground">Aucune sortie pour l’instant.</p>
          )}
        </DialogBody>
        <DialogFooter className="justify-end">
          <Button size="md" onClick={onClose}>
            Fermer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
