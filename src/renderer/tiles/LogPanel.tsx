import dialogs from '../launch/launch.module.css';
import { useDialogKeys } from '../launch/use-dialog-keys';
import styles from './tiles.module.css';

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
  useDialogKeys({ onEscape: onClose });
  const output = plain(text);
  return (
    <div role="dialog" aria-label={`Journal de ${name}`} className={dialogs.dialog}>
      <h2>Journal de {name}</h2>
      {output ? (
        <pre className={styles.log}>{output}</pre>
      ) : (
        <p className={dialogs.detail}>Aucune sortie pour l’instant.</p>
      )}
      <div className={dialogs.actions}>
        <span className={dialogs.spacer} />
        <button onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
