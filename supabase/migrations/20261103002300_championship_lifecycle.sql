-- Module 1.15: structured World Championship record, per-game confirmation, review flags and an audit trail.

create table smb.championship_cycles (
  id                uuid primary key default gen_random_uuid(),
  post_type_id      text not null default '1.1' references smb.post_types(id),
  cycle_key         text not null unique check (cycle_key ~ '^[a-z0-9][a-z0-9-]{2,60}$'),   -- 'world-championship-2026'
  title             text not null,
  official_url      text not null,                       -- the FIDE page the administrator relied on
  venue             text,
  scheduled_start   timestamptz not null,
  scheduled_end     timestamptz not null,
  total_games       integer not null check (total_games between 1 and 40),   -- classical games in the match
  player_a          jsonb not null,                      -- { name, fideId?, title?, federation? }
  player_b          jsonb not null,
  source_event_refs jsonb not null default '{}',        -- { "D3": "<broadcast id>" } by source id; D1 is added automatically
  phase             text not null default 'pre_tournament'
                      check (phase in ('pre_tournament', 'tournament', 'post_tournament')),
  phase_locked      boolean not null default false,
  phase_lock_reason text,
  is_current        boolean not null default true,
  confirmed_start   timestamptz,
  confirmed_end     timestamptz,
  winner            text check (winner in ('a', 'b')),
  next_cycle        jsonb,                               -- { stage, summary?, expectedStart?, url? }
  last_synced_at    timestamptz,
  last_sync_status  text,                                -- 'ok' | 'source_error' | 'not_due'
  last_feed_ok_at   timestamptz,
  last_feed_status  text check (last_feed_status in ('upcoming', 'in_progress', 'completed')),
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (scheduled_end > scheduled_start),
  check (confirmed_end is null or confirmed_start is not null)
);
create unique index championship_one_current on smb.championship_cycles (post_type_id) where is_current;
create trigger championship_cycles_updated_at before update on smb.championship_cycles
  for each row execute function smb.set_updated_at();

create table smb.championship_games (
  id                  uuid primary key default gen_random_uuid(),
  cycle_id            uuid not null references smb.championship_cycles(id),
  kind                text not null default 'classical' check (kind in ('classical', 'tiebreak')),
  game_number         integer not null check (game_number > 0),
  idempotency_key     text not null unique,             -- '<cycle_key>:game-7:result' (tiebreak: 'tiebreak-3')
  state               text not null default 'scheduled'
                        check (state in ('scheduled', 'in_progress', 'result_observed', 'confirmed')),
  scheduled_at        timestamptz,
  white_player        text check (white_player in ('a', 'b')),
  result              text check (result in ('1-0', '0-1', '1/2-1/2')),   -- observed or confirmed, never '*'
  d3_game_id          text,
  d3_round_id         text,
  round_label         text,                             -- provider round label, e.g. '7.1'; D1 repeats it so games merge
  round_name          text,
  round_url           text,
  pgn                 text,
  played_at           timestamptz,
  observed_at         timestamptz,
  confirmed_at        timestamptz,
  confirmed_by        text,
  confirmation_basis  text check (confirmation_basis in ('official_entry', 'corroborated')),
  result_version      integer not null default 1,
  opportunity_id      uuid references smb.post_opportunities(id),
  post_status         text not null default 'none'
                        check (post_status in ('none', 'held', 'opportunity_created', 'stale_skipped')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (cycle_id, kind, game_number),
  check ((state = 'confirmed') = (confirmed_at is not null)),
  check (state not in ('result_observed', 'confirmed') or result is not null)
);
create index championship_games_cycle on smb.championship_games (cycle_id, kind, game_number);
create trigger championship_games_updated_at before update on smb.championship_games
  for each row execute function smb.set_updated_at();

create table smb.championship_flags (
  id              uuid primary key default gen_random_uuid(),
  cycle_id        uuid not null references smb.championship_cycles(id),
  kind            text not null check (kind in
                    ('premature_start', 'late_start', 'feed_regressed', 'identity_mismatch', 'feed_unavailable',
                     'unconfirmed_games', 'conclusion_unconfirmed', 'no_unique_winner', 'overdue_conclusion',
                     'game_conflict', 'result_corrected')),
  severity        text not null check (severity in ('blocking', 'advisory')),
  auto_clear      boolean not null,
  game_number     integer,
  message         text not null,
  detail          jsonb not null default '{}',
  status          text not null default 'open' check (status in ('open', 'resolved')),
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     text,
  resolution_note text,
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index championship_flags_one_open
  on smb.championship_flags (cycle_id, kind, coalesce(game_number, 0)) where status = 'open';
create index championship_flags_open on smb.championship_flags (cycle_id) where status = 'open';

-- Everything that changed the record or why the detector did or did not act. Append-only.
create table smb.championship_log (
  id        bigint generated always as identity primary key,
  cycle_id  uuid not null references smb.championship_cycles(id),
  at        timestamptz not null default now(),
  kind      text not null,        -- 'registered','phase_changed','game_observed','game_confirmed','game_corrected',
                                  -- 'concluded','forced_phase','unlocked','flag_opened','flag_cleared','flag_resolved',
                                  -- 'emitted','emission_skipped','sync_failed','edited'
  actor     text not null,        -- admin user id, 'system'
  message   text not null,
  detail    jsonb not null default '{}'
);
create index championship_log_cycle on smb.championship_log (cycle_id, at desc);
create trigger championship_log_immutable before update or delete on smb.championship_log
  for each row execute function smb.immutable_except();

-- Automatic phase changes only move forward. An administrator going backwards sets smb.phase_override = 'on' for the transaction.
create function smb.guard_championship_phase() returns trigger
language plpgsql as $$
declare
  rank_of constant jsonb := '{"pre_tournament":1,"tournament":2,"post_tournament":3}';
begin
  if new.phase is distinct from old.phase
     and (rank_of ->> new.phase)::int < (rank_of ->> old.phase)::int
     and coalesce(current_setting('smb.phase_override', true), '') <> 'on' then
    raise exception 'championship phase may not move backwards from % to % without an administrator override', old.phase, new.phase
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger championship_cycles_phase_guard before update on smb.championship_cycles
  for each row execute function smb.guard_championship_phase();
