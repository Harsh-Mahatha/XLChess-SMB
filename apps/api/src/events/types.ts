import type { DetectedEventPayload } from '@smb/shared';
import type { OpenResult, TriggerRequest } from '../scheduling/types.js';

/**
 * Module 1.16. A detector watches approved sources for one post type and raises normalised events
 * through `ingestEvent`. V1 detectors poll; 'push' is reserved for providers that offer notifications.
 */
export interface EventDetector {
  /** Stable id, also the `smb.event_pollers` key. Example: 'championship:1.1'. */
  id: string;
  postTypeId: string | null;
  mode: 'poll';
  /** Whether a run is due now. When not due, the next due time (null = nothing to poll). */
  due(ctx: { now: Date }): Promise<{ due: true } | { due: false; nextDueAt: Date | null }>;
  run(ctx: { now: Date }): Promise<DetectorRunResult>;
}

export type DetectorOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

export interface DetectorError {
  sourceId: string;
  capability: string;
  code: string;
  message: string;
}

export interface DetectorRunResult {
  /** ok: every call succeeded; partial: some failed; failed: every call failed; skipped: nothing to poll. */
  outcome: DetectorOutcome;
  /** Normal polling interval after this run, the base for backoff. null = no further polling. */
  cadenceMs: number | null;
  errors?: DetectorError[];
  summary: unknown;
}

export type PollOutcome = DetectorOutcome | 'not_due' | 'disabled' | 'lease_held' | 'backoff';

export interface DetectorPollResult {
  id: string;
  outcome: PollOutcome;
  nextDueAt: string | null;
  consecutiveFailures: number;
  summary?: unknown;
  error?: string;
}

export interface PollSummary {
  at: string;
  detectors: DetectorPollResult[];
}

export interface IngestArgs {
  detectorId: string;
  postTypeId: string;
  payload: DetectedEventPayload;
  actor: string;
  /** Correction reason. A payload with different material facts is refused without one. */
  reason?: string;
  /**
   * The opportunity to open when the event has none yet. It runs in the ingest transaction,
   * after the event lock and the scheduler lock, so the event row and the opportunity commit together.
   */
  trigger?: Extract<TriggerRequest, { kind: 'event' }>;
  /** Record the event without opening anything (for example a stale game). */
  recordAs?: 'stale_skipped';
}

export type IngestResult =
  | {
      status: 'created' | 'replay';
      eventId: string;
      version: number;
      state: string;
      opportunityId: string | null;
      open?: OpenResult;
    }
  | {
      status: 'corrected';
      eventId: string;
      version: number;
      previousVersion: number;
      state: string;
      opportunityId: string | null;
    };

/** A payload with the same identity but different facts, sent without a correction reason. */
export class EventIdentityConflict extends Error {
  constructor(
    readonly identityKey: string,
    readonly version: number,
  ) {
    super(
      `Event ${identityKey} (v${version}) already exists with different facts; a correction needs a reason`,
    );
    this.name = 'EventIdentityConflict';
  }
}
