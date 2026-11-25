import type { EventTrigger, ResearchSubject } from '@smb/shared';

export interface OpportunityContext {
  phase: string | null;
  subject: ResearchSubject;
  eventKey: string;
}

export type TriggerRequest =
  | {
      kind: 'schedule';
      postTypeId: string;
      slotAt: Date;
      ruleKey: string;
      context: OpportunityContext;
      reason: string;
    }
  | {
      kind: 'event';
      postTypeId: string;
      event: EventTrigger;
      occurredAt: Date;
      slot: string;
      context: OpportunityContext;
      reason: string;
      actor?: string;
    }
  | {
      kind: 'manual';
      postTypeId: string;
      requestedBy: string;
      requestId: string;
      reason: string;
      context: OpportunityContext;
      scheduledFor?: Date;
      notAfter?: Date;
    };

export type RefusalCode =
  | 'unknown_post_type'
  | 'no_active_config'
  | 'post_type_disabled'
  | 'trigger_not_configured'
  | 'unknown_phase';

export type OpenResult =
  | { status: 'created'; opportunityId: string; dedupeKey: string }
  | { status: 'duplicate'; opportunityId: string; dedupeKey: string }
  | { status: 'refused'; code: RefusalCode; message: string };

export type TriggerOutcome =
  | 'created'
  | 'duplicate'
  | 'refused'
  | 'missed_coalesced'
  | 'missed_expired'
  | 'rule_inactive'
  | 'rule_active'
  | 'error';

export interface TickSummary {
  at: string;
  postTypes: number;
  created: number;
  duplicates: number;
  missed: number;
  inactive: number;
  errors: number;
}
