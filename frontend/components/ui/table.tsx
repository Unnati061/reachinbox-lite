import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

import { cn } from '@/lib/cn';

/**
 * Table primitives plus a generic `DataTable`.
 *
 * The primitives exist for one-off layouts; `DataTable` covers the common case
 * (column definitions + rows + empty/loading states) so every list screen does
 * not reinvent header markup and empty states.
 *
 * Deliberately no `onRowClick`: a click handler on <tr> is invisible to keyboard
 * and screen-reader users. Put a Button or Link in a cell instead.
 */

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    // The wrapper scrolls horizontally so a wide table never blows out the page.
    <div className="w-full overflow-x-auto rounded-lg border border-line">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...rest} />
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-surface', className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-line', className)} {...rest} />;
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-surface-muted', className)} {...rest} />;
}

export function Th({ className, scope = 'col', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cn(
        'border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle text-ink', className)} {...rest} />;
}

const ALIGN = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

const HIDE_BELOW = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
} as const;

export interface Column<T> {
  /** Stable identifier; doubles as the React key. */
  key: string;
  header: ReactNode;
  /** Cell content for one row. Returning a node (not a string) keeps badges/links possible. */
  render: (row: T) => ReactNode;
  align?: keyof typeof ALIGN;
  /** Drops the column on narrow viewports instead of forcing a horizontal scroll. */
  hideBelow?: keyof typeof HIDE_BELOW;
  className?: string;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  /** Required: index keys reorder badly once rows can be inserted or deleted. */
  getRowKey: (row: T) => string;
  /** Visually hidden by default — screen readers announce it as the table's name. */
  caption?: string;
  isLoading?: boolean;
  emptyMessage?: ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  isLoading = false,
  emptyMessage = 'Nothing here yet.',
  className,
}: DataTableProps<T>) {
  const cellClass = (column: Column<T>) =>
    cn(column.align ? ALIGN[column.align] : null, column.hideBelow ? HIDE_BELOW[column.hideBelow] : null, column.className);

  return (
    <Table className={className} aria-busy={isLoading || undefined}>
      {caption !== undefined ? <caption className="sr-only">{caption}</caption> : null}
      <THead>
        <tr>
          {columns.map((column) => (
            <Th key={column.key} className={cellClass(column)}>
              {column.header}
            </Th>
          ))}
        </tr>
      </THead>
      <TBody>
        {isLoading ? (
          SKELETON_ROWS.map((rowIndex) => (
            <tr key={`skeleton-${String(rowIndex)}`}>
              {columns.map((column) => (
                <Td key={column.key} className={cellClass(column)}>
                  <span className="block h-4 w-full max-w-32 animate-pulse rounded bg-surface-muted" />
                </Td>
              ))}
            </tr>
          ))
        ) : rows.length === 0 ? (
          <tr>
            <Td colSpan={columns.length} className="py-10 text-center text-ink-muted">
              {emptyMessage}
            </Td>
          </tr>
        ) : (
          rows.map((row) => (
            <Tr key={getRowKey(row)}>
              {columns.map((column) => (
                <Td key={column.key} className={cellClass(column)}>
                  {column.render(row)}
                </Td>
              ))}
            </Tr>
          ))
        )}
      </TBody>
    </Table>
  );
}

const SKELETON_ROWS = [0, 1, 2];
