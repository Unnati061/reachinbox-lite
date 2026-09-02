'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button, DataTable, Modal, ModalFooter } from '@/components/ui';
import type { Column } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { DependencyCheck, HealthResponse, ReadinessResponse } from '@/types';

/**
 * Renders the backend's own health report.
 *
 * Presentational on purpose: the fetch happens in the server component that
 * renders this (app/page.tsx), and "Refresh" re-runs it via router.refresh().
 * Fetching here in an effect would trip react-hooks/set-state-in-effect and
 * would need a data-fetching library to do properly — see DECISIONS.md.
 */

export interface HealthSnapshot {
  health: HealthResponse | null;
  readiness: ReadinessResponse | null;
  /** Message from a failed probe; null when the API answered. */
  error: string | null;
}

const STATUS_STYLES: Record<DependencyCheck['status'], string> = {
  up: 'bg-success/15 text-success',
  down: 'bg-danger/15 text-danger',
};

const COLUMNS: readonly Column<DependencyCheck>[] = [
  {
    key: 'name',
    header: 'Dependency',
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span
        className={cn(
          'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold uppercase',
          STATUS_STYLES[row.status],
        )}
      >
        {row.status}
      </span>
    ),
  },
  {
    key: 'latency',
    header: 'Latency',
    align: 'right',
    render: (row) => <span className="font-mono text-xs">{row.latencyMs} ms</span>,
  },
  {
    key: 'error',
    header: 'Detail',
    hideBelow: 'sm',
    render: (row) => <span className="text-ink-muted">{row.error ?? '—'}</span>,
  },
];

export function StatusPanel({ snapshot }: { snapshot: HealthSnapshot }) {
  const { health, readiness, error } = snapshot;
  const router = useRouter();
  // useTransition gives a pending flag for the duration of the server re-render,
  // so the button can show a spinner without any local loading state.
  const [isRefreshing, startTransition] = useTransition();
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const refresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg font-semibold">API status</h2>
          <p className="text-sm text-ink-muted">
            {health === null
              ? 'The API did not answer.'
              : `Up ${String(health.uptimeSeconds)}s · ${
                  readiness?.ready === true ? 'ready to serve traffic' : 'not ready'
                }`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setIsDetailOpen(true)}>
            Raw response
          </Button>
          <Button size="sm" isLoading={isRefreshing} onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {error === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <strong className="font-semibold text-danger">Could not reach the API</strong>
          <span className="text-ink-muted">{error}</span>
          <span className="text-ink-muted">
            Start it with <code className="font-mono text-ink">npm run dev:backend</code>.
          </span>
        </div>
      )}

      <DataTable
        caption="Backend dependency health"
        columns={COLUMNS}
        rows={readiness?.dependencies ?? []}
        getRowKey={(row) => row.name}
        isLoading={isRefreshing && readiness === null}
        emptyMessage={
          error === null ? 'No dependency report yet.' : 'Dependency report unavailable.'
        }
      />

      <Modal
        open={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
        title="Raw health response"
        description="Exactly what /health and /health/ready returned."
        footer={
          <ModalFooter>
            <Button variant="secondary" onClick={() => setIsDetailOpen(false)}>
              Close
            </Button>
          </ModalFooter>
        }
      >
        <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-xs">
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      </Modal>
    </section>
  );
}
