-- Module 1.16: event detection and trigger ingestion.
-- A ledger of every normalised event SMB acts on, its versions, per-detector poll state,
-- the link from an opportunity to the event version it was built from, and championship
-- columns for sticky observations, corroboration stability and round-aware polling.

-- One row per event identity ('<cycle>:game-7:result'). Replays update seen_count; corrections add a version.
create table smb.detected_events (
  id              uuid primary key default gen_random_uuid(),
  identity_key    text not null unique,
  kind            text not null check (kind in
                    ('game_completed', 'round_completed', 'tournament_started', 'tournament_completed',
                     'rating_list_published', 'news_published')),
  post_type_id    text not null references smb.post_types(id),
  detector_id     text not null,
  version         integer not null default 1 check (version >= 1),
  payload         jsonb not null,
  material_hash   text not null check (material_hash ~ '^[0-9a-f]{64}$'),
  state           text not null default 'recorded'
                    check (state in ('recorded', 'opportunity_created', 'refused', 'stale_skipped', 'held')),
  opportunity_id  uuid references smb.post_opportunities(id),
  refusal_code    text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  seen_count      integer not null default 1 check (seen_count >= 1),
  corrected_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((state = 'opportunity_created') = (opportunity_id is not null)),
  check ((state = 'refused') = (refusal_code is not null)),
  check ((version > 1) = (corrected_at is not null))
);
create index detected_events_type_time on smb.detected_events (post_type_id, first_seen_at desc);
create index detected_events_opportunity on smb.detected_events (opportunity_id);
create trigger detected_events_updated_at before update on smb.detected_events
  for each row execute function smb.set_updated_at();

-- The identity of a ledger row never changes, and its version only moves forward.
create function smb.guard_detected_event() returns trigger
language plpgsql as $$
begin
  if new.identity_key is distinct from old.identity_key
     or new.kind is distinct from old.kind
     or new.post_type_id is distinct from old.post_type_id
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'detected_events identity columns are immutable';
  end if;
  if new.version < old.version then
    raise exception 'detected_events.version cannot decrease (% -> %)', old.version, new.version;
  end if;
  return new;
end;
$$;
create trigger detected_events_guard before update on smb.detected_events
  for each row execute function smb.guard_detected_event();

-- Every version of every event, including the first. Append-only.
create table smb.detected_event_versions (
  id             bigint generated always as identity primary key,
  event_id       uuid not null references smb.detected_events(id),
  version        integer not null check (version >= 1),
  payload        jsonb not null,
  material_hash  text not null,
  reason         text not null,              -- 'first_seen' or the correction reason
  actor          text not null,
  at             timestamptz not null default now(),
  unique (event_id, version)
);
create trigger detected_event_versions_immutable before update or delete on smb.detected_event_versions
  for each row execute function smb.immutable_except();

-- One row per registered detector: health, backoff and a lease so two API instances never run one detector at once.
create table smb.event_pollers (
  detector_id          text primary key,
  post_type_id         text references smb.post_types(id),
  enabled              boolean not null default true,
  next_due_at          timestamptz,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_outcome         text check (last_outcome in ('ok', 'partial', 'failed', 'not_due', 'skipped')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error           jsonb,
  lease_until          timestamptz,
  lease_holder         text,
  updated_at           timestamptz not null default now(),
  check ((lease_until is null) = (lease_holder is null))
);
create trigger event_pollers_updated_at before update on smb.event_pollers
  for each row execute function smb.set_updated_at();

-- Which event version an opportunity was built from. version < detected_events.version means its facts changed (1.17).
alter table smb.post_opportunities
  add column trigger_event_id      uuid references smb.detected_events(id),
  add column trigger_event_version integer check (trigger_event_version is null or trigger_event_version >= 1),
  add constraint post_opportunities_trigger_event_pair
    check ((trigger_event_id is null) = (trigger_event_version is null));
create index post_opportunities_trigger_event on smb.post_opportunities (trigger_event_id);

-- Sticky observations and corroboration stability.
alter table smb.championship_games
  add column observed_result_since timestamptz,          -- reset whenever a feed disagrees with the observed result
  add column observed_sources      text[] not null default '{}',
  add column feed_regressed_at     timestamptz;          -- set while the feed shows an observed game as unfinished or missing

-- Round-aware polling cadence, from the last successful events fetch.
alter table smb.championship_cycles
  add column next_round_at  timestamptz,
  add column any_round_live boolean not null default false;

-- New flag kind: a feed reported a different final result for an observed, unconfirmed game.
alter table smb.championship_flags drop constraint championship_flags_kind_check;
alter table smb.championship_flags add constraint championship_flags_kind_check check (kind in
  ('premature_start', 'late_start', 'feed_regressed', 'identity_mismatch', 'feed_unavailable',
   'unconfirmed_games', 'conclusion_unconfirmed', 'no_unique_winner', 'overdue_conclusion',
   'game_conflict', 'result_corrected', 'observation_changed'));
