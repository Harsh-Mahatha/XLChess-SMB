-- Module 1.2 (3/9): background job queue (Postgres-backed, claimed with FOR UPDATE SKIP LOCKED).
-- opportunity_id gets its foreign key in the next migration.

create table smb.jobs (
  id               uuid primary key default gen_random_uuid(),
  lane             smb.job_lane not null,
  kind             text not null,
  status           smb.job_status not null default 'queued',
  priority         integer not null default 100,       -- lower runs first
  payload          jsonb not null default '{}',
  payload_version  integer not null default 1,
  result           jsonb,
  opportunity_id   uuid,
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  lease_id         uuid,
  leased_by        uuid,                               -- worker id; FK added with the workers table (1.18)
  lease_expires_at timestamptz,
  run_after        timestamptz not null default now(),
  not_after        timestamptz,                        -- stale work expires instead of running
  idempotency_key  text unique,
  last_error       text,
  payload_purged_at timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (attempts <= max_attempts),
  check ((status = 'leased') = (lease_id is not null))
);
create index jobs_claim on smb.jobs (lane, priority, run_after) where status = 'queued';
create index jobs_expired_leases on smb.jobs (lease_expires_at) where status = 'leased';
create index jobs_opportunity on smb.jobs (opportunity_id);
create trigger jobs_updated_at before update on smb.jobs
  for each row execute function smb.set_updated_at();
