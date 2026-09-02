'use client';

import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Modal built on the native <dialog> element.
 *
 * `showModal()` gives us the focus trap, Escape handling, `inert` background,
 * top-layer stacking (no z-index fights) and focus restoration for free — all
 * the things a hand-rolled div modal gets subtly wrong. The cost is that open
 * state has to be pushed into the DOM node via an effect, which is what the
 * effect below does.
 */

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const;

export interface ModalProps {
  open: boolean;
  /** Called on Escape, backdrop click, and the close button. Must flip `open`. */
  onClose: () => void;
  title: string;
  /** Optional sub-heading; also wired as the dialog's accessible description. */
  description?: string;
  children?: ReactNode;
  /** Action row, typically Buttons. Wrap in <ModalFooter> for spacing. */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Set false to block Escape and backdrop dismissal (e.g. a send in flight). */
  dismissable?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissable = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    // showModal() throws InvalidStateError if the dialog is already open, and
    // close() on a closed dialog is a no-op — so gate both on dialog.open.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    // Escape fires `cancel` first. Cancelling it keeps the DOM open and lets the
    // parent's state remain the single source of truth (the effect above then
    // performs the actual close) — otherwise the node and React disagree.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (dismissable) onClose();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [dismissable, onClose]);

  // The dialog element itself is only hit when the click lands on the backdrop;
  // all padding lives on the inner wrapper so content clicks target a child.
  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (dismissable && event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      onClick={handleClick}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      className={cn(
        'w-[calc(100%-2rem)] rounded-lg border border-line bg-canvas p-0 text-ink shadow-xl',
        'max-h-[85dvh] overflow-hidden backdrop:bg-black/60',
        SIZES[size],
      )}
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className="text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          {dismissable ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="-mt-1 -mr-1 rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <svg
                className="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </header>

        {/* Only the body scrolls, so header and actions stay reachable. */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer === undefined ? null : (
          <footer className="border-t border-line bg-surface px-5 py-3">{footer}</footer>
        )}
      </div>
    </dialog>
  );
}

/** Right-aligned action row that stacks on very narrow screens. */
export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}>
      {children}
    </div>
  );
}
