-- Module 1.2 (1/9): shared trigger helpers and enums.

create function smb.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Append-only guard. DELETE is always refused. UPDATE is refused unless it only touches
-- the columns listed in the trigger arguments (e.g. a soft-delete marker).
--   create trigger ... before update or delete on t
--     for each row execute function smb.immutable_except();            -- fully immutable
--     for each row execute function smb.immutable_except('deleted_at'); -- only deleted_at may change
create function smb.immutable_except() returns trigger
language plpgsql as $$
declare
  allowed text[] := coalesce(tg_argv, '{}');
begin
  if tg_op = 'DELETE' then
    raise exception 'smb.% is append-only: DELETE is not allowed', tg_table_name
      using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'smb.% is append-only: only [%] may be updated', tg_table_name, array_to_string(allowed, ', ')
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create type smb.opportunity_status as enum (
  'pending', 'researching', 'generating', 'awaiting_review', 'approved', 'scheduled',
  'publishing', 'published', 'partially_published', 'rejected', 'deferred', 'failed'
);
-- Must stay in sync with JobStatus / JobLane in packages/shared (enforced by a test).
create type smb.job_status as enum ('queued', 'leased', 'succeeded', 'failed', 'dead', 'cancelled', 'expired');
create type smb.job_lane as enum ('server', 'gpu');
create type smb.channel as enum ('x', 'facebook', 'instagram', 'discord');
create type smb.publish_mode as enum ('dry_run', 'sandbox', 'live');
create type smb.publication_status as enum ('pending', 'publishing', 'published', 'dry_run_recorded', 'failed', 'cancelled');
create type smb.review_action_type as enum ('approve', 'reject', 'defer', 'regenerate', 'request_research', 'comment');
create type smb.claim_verification as enum ('unverified', 'single_source', 'verified', 'conflicting');
create type smb.asset_kind as enum ('original', 'derived', 'render', 'evidence');
create type smb.licence_decision as enum ('accepted', 'rejected');
