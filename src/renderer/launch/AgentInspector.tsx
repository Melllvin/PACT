import type { ReactNode } from 'react';
import {
  differences,
  effective,
  preview,
  setAgent,
  setCommon,
  setOverride,
  type CommonSettings,
  type LaunchDraft,
  type SettingKey,
} from '../../shared/launch-draft';
import type { Agent, CliDefinition, PermissionLevel } from '../../shared/model';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** research.md R5: the three levels, as 1d names them. */
const LEVELS: [PermissionLevel, string][] = [
  ['always-ask', 'Demander'],
  ['ask-sensitive', 'Auto · worktree'],
  ['always-allow', 'Tout auto'],
];

const CONTROL =
  'w-full min-w-0 rounded-[5px] border border-border bg-[#0a0d12] px-[9px] py-1.5 text-[12.5px] text-foreground group-data-[inherited=true]:border-dashed group-data-[inherited=true]:bg-transparent group-data-[inherited=true]:text-muted-foreground';

type AgentInspectorProps = {
  draft: LaunchDraft;
  onChange: (draft: LaunchDraft) => void;
  /** Installed CLIs, in the order the CLI field offers them. */
  clis: CliDefinition[];
  /** Agents of this workspace: the color the inspected agent will get. */
  running: Pick<Agent, 'position' | 'color'>[];
  /** The agent inspected, or null for « Commun à tous ». */
  index: number | null;
  onDuplicate: () => void;
  onRemove: () => void;
};

type FieldProps = {
  label: string;
  /** Shown dashed: the agent takes the common value. */
  inherited?: boolean;
  /** ≠: the agent sets another value than the common one. */
  differs?: boolean;
  onReset?: (() => void) | undefined;
  children: ReactNode;
};

function Field({ label, inherited = false, differs = false, onReset, children }: FieldProps) {
  return (
    <div
      role="group"
      aria-label={label}
      data-inherited={inherited}
      className="group grid grid-cols-[96px_minmax(0,1fr)_32px] items-center gap-2.5"
    >
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      <span className="flex items-center gap-1 font-mono text-[11px]">
        {differs && (
          <span aria-label="diffère du commun" className="text-primary">
            ≠
          </span>
        )}
        {onReset && (
          <button
            className="cursor-pointer text-muted-foreground hover:text-foreground"
            title="Revenir au commun"
            aria-label="Revenir au commun"
            onClick={onReset}
          >
            ↺
          </button>
        )}
      </span>
    </div>
  );
}

const SECTION =
  'm-0 mt-1 font-mono text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase';

/** Right of 1d: what the selected item sets, the agent showing in full only what it overrides. */
export function AgentInspector({
  draft,
  onChange,
  clis,
  index,
  running,
  onDuplicate,
  onRemove,
}: AgentInspectorProps) {
  const agent = index === null ? null : draft.agents[index];
  const settings = index === null ? draft.common : effective(draft, index);
  const changed = index === null ? [] : differences(draft, index);
  const cli = agent ? clis.find((c) => c.id === agent.cliId) : undefined;
  const models = agent ? (cli?.models ?? []) : [...new Set(clis.flatMap((c) => c.models))];
  const color = index === null ? undefined : preview(draft, running)[index]?.color;

  /** A common value, or an agent override; an agent set back to the common value inherits it. */
  const set = <K extends SettingKey>(key: K, value: CommonSettings[K]) => {
    if (index === null) onChange(setCommon(draft, key, value));
    else onChange(setOverride(draft, index, key, value === draft.common[key] ? undefined : value));
  };
  const field = (key: SettingKey) =>
    index === null
      ? {}
      : {
          inherited: !(key in (agent?.overrides ?? {})),
          differs: changed.includes(key),
          onReset:
            key in (agent?.overrides ?? {})
              ? () => {
                  onChange(setOverride(draft, index, key, undefined));
                }
              : undefined,
        };
  /** An agent's own text value; the common one shows as its placeholder. */
  const text = (key: 'baseBranch' | 'startCommand') =>
    agent ? (agent.overrides[key] ?? '') : (draft.common[key] ?? '');
  const orNull = (value: string) => (value.trim() === '' ? null : value);
  const setText = (key: 'baseBranch' | 'startCommand', value: string) => {
    if (index === null) onChange(setCommon(draft, key, orNull(value)));
    else onChange(setOverride(draft, index, key, value === '' ? undefined : value));
  };

  return (
    <section
      aria-label="Inspecteur"
      className="flex min-h-0 min-w-0 flex-col gap-[9px] overflow-auto px-4 py-3.5"
    >
      <header className="flex items-center gap-2">
        {color && (
          <span
            aria-hidden
            className="size-2.5 flex-none rounded-full"
            style={{ background: `var(--agent-${color})` }}
          />
        )}
        <h3 className="m-0 flex-1 text-[15px] font-semibold">
          {agent ? (cli?.name ?? agent.cliId) : 'Commun à tous'}
        </h3>
        {agent && (
          <>
            <Button onClick={onDuplicate}>Dupliquer</Button>
            <Button onClick={onRemove}>Retirer</Button>
          </>
        )}
      </header>

      <h4 className={SECTION}>Agent</h4>

      {agent && index !== null && (
        <Field label="CLI">
          <select
            aria-label="CLI"
            className={CONTROL}
            value={agent.cliId}
            onChange={(event) => {
              onChange(setAgent(draft, index, { cliId: event.target.value }));
            }}
          >
            {clis.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Modèle" {...field('model')}>
        <select
          aria-label="Modèle"
          className={CONTROL}
          value={settings.model !== null && models.includes(settings.model) ? settings.model : ''}
          onChange={(event) => {
            set('model', orNull(event.target.value));
          }}
        >
          <option value="">Par défaut du CLI</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Permissions" {...field('permissionLevel')}>
        <span className="flex w-fit overflow-hidden rounded-md border border-border text-[11.5px] font-medium group-data-[inherited=true]:border-dashed">
          {LEVELS.map(([level, label]) => (
            <button
              key={level}
              aria-pressed={settings.permissionLevel === level}
              className={cn(
                'cursor-pointer px-[9px] py-[3px] not-first:border-l not-first:border-border',
                settings.permissionLevel === level && 'bg-primary text-primary-foreground',
              )}
              onClick={() => {
                set('permissionLevel', level);
              }}
            >
              {label}
            </button>
          ))}
        </span>
      </Field>

      <h4 className={SECTION}>Git</h4>
      <Field label="Branche de base" {...field('baseBranch')}>
        <input
          aria-label="Branche de base"
          className={CONTROL}
          value={text('baseBranch')}
          placeholder={draft.common.baseBranch ?? 'branche principale'}
          onChange={(event) => {
            setText('baseBranch', event.target.value);
          }}
        />
      </Field>

      {agent && index !== null && (
        <>
          <Field label="Branche">
            <input
              aria-label="Branche"
              className={CONTROL}
              value={agent.branch ?? ''}
              placeholder="auto — choisie par l’agent"
              onChange={(event) => {
                onChange(setAgent(draft, index, { branch: orNull(event.target.value) }));
              }}
            />
          </Field>
        </>
      )}

      <h4 className={SECTION}>Aperçu</h4>
      {agent && index !== null && (
        <>
          <Field label="Port">
            <input
              aria-label="Port"
              inputMode="numeric"
              className={CONTROL}
              value={agent.port === null ? '' : String(agent.port)}
              placeholder="auto"
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, '').slice(0, 5);
                onChange(setAgent(draft, index, { port: digits ? Number(digits) : null }));
              }}
            />
          </Field>
        </>
      )}

      <Field label="Commande" {...field('startCommand')}>
        <input
          aria-label="Commande"
          className={CONTROL}
          value={text('startCommand')}
          placeholder={draft.common.startCommand ?? 'aucune'}
          onChange={(event) => {
            setText('startCommand', event.target.value);
          }}
        />
      </Field>
    </section>
  );
}
