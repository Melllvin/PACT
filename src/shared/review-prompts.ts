import type { ReviewComment } from './model';

// 002 research R7 — what the review types into the agent's prompt (FR-012, FR-013, FR-015).

type Quoted = Pick<ReviewComment, 'path' | 'line' | 'text'>;

export type ReviewPrompt =
  | ({ kind: 'comment' } & Quoted)
  | { kind: 'fix-comments'; comments: Quoted[] }
  | { kind: 'failing-tests'; command: string; output: string }
  | { kind: 'conflict'; mainBranch: string; files: string[] }
  | { kind: 'request'; text: string };

/** The lines of test output given to the agent: enough to see what failed. */
const TAIL_LINES = 40;

const quote = ({ path, line, text }: Quoted) => `${path}:${String(line)} — ${text}`;

export function reviewPrompt(prompt: ReviewPrompt): string {
  switch (prompt.kind) {
    case 'comment':
      return `Commentaire sur ${quote(prompt)}`;
    case 'fix-comments':
      return [
        'Corrige les commentaires de la revue :',
        ...prompt.comments.map((c) => `- ${quote(c)}`),
      ].join('\n');
    case 'failing-tests': {
      const head = `Les tests échouent (\`${prompt.command}\`). Corrige-les.`;
      const output = prompt.output.trimEnd();
      if (output.trim() === '') return head;
      const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
      return `${head} Fin de la sortie :\n${tail}`;
    }
    case 'conflict': {
      const { mainBranch: main } = prompt;
      return (
        `Conflit avec ${main} sur ${prompt.files.join(', ')}. Mets ta branche à jour depuis ` +
        `${main}, résous les conflits, puis relance les tests.`
      );
    }
    case 'request':
      return prompt.text;
  }
}
