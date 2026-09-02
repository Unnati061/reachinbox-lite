'use client';

import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { cn } from '@/lib/cn';

/**
 * Form controls.
 *
 * Each control renders its own label, hint and error and wires `id`,
 * `aria-describedby` and `aria-invalid` itself. Callers that only pass strings
 * cannot forget the accessible plumbing, which is the whole point of having
 * these instead of raw <input> elements.
 *
 * 'use client' because `useId` is a hook — these are interactive by nature.
 */

/** Shared chrome, so input/textarea/select never drift apart visually. */
const CONTROL = cn(
  'w-full rounded-md border border-line bg-canvas text-ink',
  'px-3 py-2 text-sm placeholder:text-ink-muted',
  'transition-colors focus:border-accent',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-danger',
);

interface FieldChrome {
  label: string;
  /** Helper text below the control. Hidden while `error` is set. */
  hint?: string;
  /** Non-empty marks the control invalid and is announced to screen readers. */
  error?: string;
  /** Applied to the wrapper, not the control. */
  className?: string;
}

function useField(args: { id?: string; hint?: string; error?: string }) {
  // useId survives SSR hydration; Math.random or a counter would not.
  const generated = useId();
  const id = args.id ?? generated;
  const hasError = args.error !== undefined && args.error !== '';
  const describedBy =
    [hasError ? `${id}-error` : null, args.hint !== undefined ? `${id}-hint` : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return { id, hasError, describedBy };
}

function FieldShell({
  id,
  label,
  hint,
  error,
  hasError,
  className,
  children,
}: FieldChrome & { id: string; hasError: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hasError ? (
        // role="alert" so a validation failure is announced, not just coloured.
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { controlClassName?: string };

export function Input({ label, hint, error, className, controlClassName, ...rest }: InputProps) {
  const { id, hasError, describedBy } = useField({ id: rest.id, hint, error });
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      hasError={hasError}
      className={className}
    >
      <input
        {...rest}
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={cn(CONTROL, 'h-10', controlClassName)}
      />
    </FieldShell>
  );
}

export type TextareaProps = FieldChrome &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & { controlClassName?: string };

export function Textarea({
  label,
  hint,
  error,
  className,
  controlClassName,
  rows = 5,
  ...rest
}: TextareaProps) {
  const { id, hasError, describedBy } = useField({ id: rest.id, hint, error });
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      hasError={hasError}
      className={className}
    >
      <textarea
        {...rest}
        id={id}
        rows={rows}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={cn(CONTROL, 'resize-y', controlClassName)}
      />
    </FieldShell>
  );
}

export type SelectProps = FieldChrome &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
    controlClassName?: string;
    options: readonly { value: string; label: string; disabled?: boolean }[];
    /** Rendered as a disabled first option, for "choose one" states. */
    placeholder?: string;
  };

export function Select({
  label,
  hint,
  error,
  className,
  controlClassName,
  options,
  placeholder,
  ...rest
}: SelectProps) {
  const { id, hasError, describedBy } = useField({ id: rest.id, hint, error });
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      hasError={hasError}
      className={className}
    >
      <select
        {...rest}
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={cn(CONTROL, 'h-10 pr-8', controlClassName)}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
