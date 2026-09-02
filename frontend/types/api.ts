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
