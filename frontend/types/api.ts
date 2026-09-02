/**
 * Shapes returned by the ReachInbox-lite API.
 *
 * Hand-maintained mirror of the backend's response types. If these drift, the
 * typed client lies — so when a backend response shape changes, change it here
 * in the same commit. (Generating these from the API is a later improvement.)
 */

/** Envelope used by every error response. Mirrors backend ApiErrorBody. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export type DependencyName = 'postgres' | 'redis';
export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  name: DependencyName;
  status: DependencyStatus;
  latencyMs: number;
  error?: string;
}

export interface ReadinessResponse {
  ready: boolean;
  dependencies: DependencyCheck[];
}

export type EmailStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface ScheduledEmailListItem {
  id: string;
  batch_id: string | null;
  sender_id: string;
  recipient_email: string;
  subject: string;
  scheduled_at: string;
  status: EmailStatus;
  bullmq_job_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; per_page: number; total: number; total_pages: number; has_more: boolean };
}

export interface ScheduleBatchResponse {
  batch_id: string;
  scheduled_count: number;
  duplicates_removed: number;
  start_at: string;
  last_scheduled_at: string;
  effective_step_ms: number;
  hourly_limit: number | null;
}
