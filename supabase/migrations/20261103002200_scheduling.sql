-- Module 1.14: scheduling state, suspension, the trigger log, and why-fields on opportunities.

alter table smb.post_opportunities
  add column trigger_reason text,
  add column triggered_by   text not null default 'system';

-- One row per recurring (time-based) rule of a post type's active config.
-- event and manual rules have no row: they are not driven by the clock.
create table smb.schedules (
  id                  uuid primary key default gen_random_uuid(),
  post_type_id        text not null references smb.post_types(id),
  rule_key            text not null,           -- '<phase|base>|<timezone>|weekly|fri|09:00'
  phase_id            text,                    -- null = the post type's base schedule
  rule                jsonb not null,          -- the ScheduleRule as configured
  timezone            text not null,
  anchor_at           timestamptz not null,    -- interval rules count from here
  cursor_at           timestamptz not null,    -- every slot <= cursor_at has been handled
  next_run_at         timestamptz,             -- null while inactive or retired
  state               text not null default 'active' check (state in ('active', 'inactive', 'retired')),
  inactive_reason     text check (inactive_reason in
                        ('post_type_disabled', 'config_disabled', 'suspended', 'phase_inactive', 'held_for_review')),
  last_slot_at        timestamptz,
  last_opportunity_id uuid references smb.post_opportunities(id),
  last_outcome        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (post_type_id, rule_key),
  check ((state = 'inactive') = (inactive_reason is not null))
);
create index schedules_next_run on smb.schedules (next_run_at) where state = 'active';
create trigger schedules_updated_at before update on smb.schedules
  for each row execute function smb.set_updated_at();

-- Temporary or indefinite suspension of a post type's recurring rules. Row present = suspended.
create table smb.schedule_holds (
  post_type_id    text primary key references smb.post_types(id),
  suspended_until timestamptz,                 -- null = until an administrator resumes
  reason          text not null,
  created_by      text not null,
  created_at      timestamptz not null default now()
);

-- Why and when every trigger did or did not create work. Append-only.
create table smb.trigger_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  post_type_id   text not null references smb.post_types(id),
  trigger_kind   text not null check (trigger_kind in ('schedule', 'event', 'manual')),
  outcome        text not null check (outcome in
                   ('created', 'duplicate', 'refused', 'missed_coalesced', 'missed_expired',
                    'rule_inactive', 'rule_active', 'error')),
  rule_key       text,
  slot_at        timestamptz,
  dedupe_key     text,
  opportunity_id uuid references smb.post_opportunities(id),
  reason         text not null,
  detail         jsonb not null default '{}'
);
create index trigger_log_type_time on smb.trigger_log (post_type_id, at desc);
create index trigger_log_opportunity on smb.trigger_log (opportunity_id);
create trigger trigger_log_immutable before update or delete on smb.trigger_log
  for each row execute function smb.immutable_except();
