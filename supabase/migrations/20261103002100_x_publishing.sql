-- Module 1.13 (2/2): retry and claim tracking, publication state machine, and widened attempt outcomes.

-- 1. New columns on smb.publications
alter table smb.publications
  add column if not exists retry_after timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists lookup_count integer not null default 0,
  add column if not exists media_ids text[] not null default '{}';

-- 2. Recreate the update guard so the new columns may change
drop trigger if exists publications_guard on smb.publications;
create trigger publications_guard before update or delete on smb.publications
  for each row execute function smb.immutable_except(
    'status', 'external_id', 'url', 'published_at', 'last_error', 'updated_at',
    'retry_after', 'claimed_at', 'attempt_count', 'lookup_count', 'media_ids'
  );

-- 3. Checks on smb.publications
alter table smb.publications
  add constraint publications_dry_run_recorded_check check (status <> 'dry_run_recorded' or mode = 'dry_run'),
  add constraint publications_dry_run_mode_check check (mode <> 'dry_run' or status not in ('published', 'uncertain')),
  add constraint publications_published_url_check check (status <> 'published' or url is not null);

-- 4. Allowed status moves
create or replace function smb.check_publication_transition() returns trigger
language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status = 'pending' and new.status in ('publishing', 'cancelled', 'failed') then
    return new;
  end if;

  if old.status = 'publishing' and new.status in ('published', 'dry_run_recorded', 'uncertain', 'pending', 'failed') then
    return new;
  end if;

  if old.status = 'uncertain' and new.status in ('published', 'pending', 'failed') then
    return new;
  end if;

  if old.status = 'failed' and new.status = 'pending' then
    return new;
  end if;

  raise exception 'invalid publication status transition from % to %', old.status, new.status
    using errcode = 'check_violation';
end $$;

drop trigger if exists publications_transition on smb.publications;
create trigger publications_transition before update of status on smb.publications
  for each row execute function smb.check_publication_transition();

-- 5. Widen publication_attempts.outcome and add kind
alter table smb.publication_attempts drop constraint if exists publication_attempts_outcome_check;
alter table smb.publication_attempts add constraint publication_attempts_outcome_check
  check (outcome in ('success','failure','timeout','dry_run','rate_limited','refused','lookup_found','lookup_absent','lookup_failed','manual'));

alter table smb.publication_attempts add column if not exists kind text not null default 'send'
  check (kind in ('send','lookup','manual'));

-- 6. Index for the sweeper
create index if not exists publications_due on smb.publications (status, retry_after, scheduled_for)
  where status in ('pending', 'uncertain', 'publishing');

-- 7. Comments
comment on column smb.publications.retry_after is 'Earliest time the publisher may retry or reconcile this publication.';
comment on column smb.publications.claimed_at is 'When the current send attempt was claimed; used for timeout detection.';
comment on column smb.publications.attempt_count is 'Number of times a send has been attempted.';
comment on column smb.publications.lookup_count is 'Number of reconciliation lookups attempted while uncertain.';
comment on column smb.publications.media_ids is 'Channel media IDs uploaded for this row, so a retry after a failed create can reuse them while still valid.';
comment on column smb.publication_attempts.kind is 'Kind of attempt: send to channel, reconciliation lookup, or manual intervention.';
