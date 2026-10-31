import type { ReviewComment } from './model';

// 002 R7 — the instructions the review types into the agent's CLI, built here and nowhere else.

/** « Tests en échec » quotes this many lines of the output. */
export const FAILING_TAIL_LINES = 40;

type Comment = Pick<ReviewComment, 'path' | 'line' | 'text'>;

const where = ({ path, line }: Comment) => `${path}:${String(line)}`;

/** A comment on one line of the diff (FR-012). */
export const commentPrompt = (comment: Comment) =>
  `Commentaire sur ${where(comment)} — ${comment.text.trim()}`;

/** « Corriger les commentaires · N »: every comment given, in one prompt (FR-013). */
export function fixCommentsPrompt(comments: Comment[]): string {
  const items = comments.map(
    (comment) => `- ${where(comment)} — ${comment.text.trim().replaceAll('\n', '\n  ')}`,
  );
  return ['Corrige les commentaires de revue suivants :', ...items].join('\n');
}

/** « Tests en échec »: the command, then the end of its output (FR-013). */
export function failingTestsPrompt(command: string, output: string): string {
  const head = `Les tests échouent (\`${command}\`). Corrige-les, puis relance-les.`;
  const lines = output.trimEnd().split('\n').slice(-FAILING_TAIL_LINES);
  if (output.trim() === '') return head;
  return [head, 'Dernières lignes de la sortie :', ...lines].join('\n');
}

/** « Conflit avec main » and « Demander à l'agent » of screen 1q (FR-013, FR-028). */
export const conflictPrompt = (mainBranch: string, files: string[]) =>
  [
    `Ta branche est en conflit avec ${mainBranch} sur : ${files.join(', ')}.`,
    `Mets ta branche à jour depuis ${mainBranch} dans ton worktree (rebase ou merge), résous les conflits, puis relance les tests.`,
  ].join('\n');

/** « Renvoyer à l'agent »: the request as written (FR-015). */
export const requestPrompt = (text: string) => text.trim();
