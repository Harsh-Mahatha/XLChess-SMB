-- Module 1.2 (4/9): posting opportunities, their state history, research packages and claims.

create table smb.post_opportunities (
  id             uuid primary key default gen_random_uuid(),
  post_type_id   text not null references smb.post_types(id),
  post_config_id uuid not null references smb.post_configs(id),   -- exact config version used
  dedupe_key     text not null unique,                            -- e.g. '1.1:wcc-2026:game-7'
  trigger_kind   text not null check (trigger_kind in ('schedule', 'event', 'manual')),
  trigger_ref    jsonb not null default '{}',
  phase          text,
  status         smb.opportunity_status not null default 'pending',
  priority       integer not null default 100,
  scheduled_for  timestamptz,
  not_after      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index post_opportunities_status on smb.post_opportunities (status, scheduled_for);
create trigger post_opportunities_updated_at before update on smb.post_opportunities
  for each row execute function smb.set_updated_at();

alter table smb.jobs add constraint jobs_opportunity_fk
  foreign key (opportunity_id) references smb.post_opportunities(id);

-- History of every state change. Written by a trigger so no code path can forget it.
-- The application sets smb.actor (and optionally smb.reason / smb.job_id) per transaction with set_config().
create table smb.opportunity_events (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,     -- total order, even within one transaction
  opportunity_id uuid not null references smb.post_opportunities(id),
  from_status    smb.opportunity_status,
  to_status      smb.opportunity_status not null,
  actor          text not null default 'system',
  reason         text,
  job_id         uuid references smb.jobs(id),
  created_at     timestamptz not null default now()
);
create index opportunity_events_opportunity on smb.opportunity_events (opportunity_id, seq);
create trigger opportunity_events_immutable before update or delete on smb.opportunity_events
  for each row execute function smb.immutable_except();

create function smb.log_opportunity_status() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into smb.opportunity_events (opportunity_id, from_status, to_status, actor, reason, job_id)
    values (
      new.id,
      case when tg_op = 'UPDATE' then old.status end,
      new.status,
      coalesce(nullif(current_setting('smb.actor', true), ''), 'system'),
      nullif(current_setting('smb.reason', true), ''),
      nullif(current_setting('smb.job_id', true), '')::uuid
    );
  end if;
  return null;
end $$;
create trigger post_opportunities_log_status after insert or update on smb.post_opportunities
  for each row execute function smb.log_opportunity_status();

create table smb.research_packages (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references smb.post_opportunities(id),
  version        integer not null check (version > 0),
  status         text not null default 'building' check (status in ('building', 'complete', 'partial', 'failed')),
  summary        jsonb not null default '{}',
  content_hash   text check (content_hash ~ '^[0-9a-f]{64}$'),
  job_id         uuid references smb.jobs(id),
  created_at     timestamptz not null default now(),
  unique (opportunity_id, version)
);
-- A package can be finalised (status, summary, hash) but its identity and links never change.
create trigger research_packages_guard before update or delete on smb.research_packages
  for each row execute function smb.immutable_except('status', 'summary', 'content_hash');

create table smb.research_claims (
  id             uuid primary key default gen_random_uuid(),
  package_id     uuid not null references smb.research_packages(id),
  claim_key      text not null,                          -- the claimId the generator cites
  description    text not null,
  value          jsonb not null,
  computed       boolean not null default false,         -- true when calculated in code
  computation    text,                                   -- e.g. 'current_rating - starting_rating'
  verification   smb.claim_verification not null default 'unverified',
  confidence     numeric(3, 2) check (confidence between 0 and 1),
  event_time     timestamptz,
  created_at     timestamptz not null default now(),
  unique (package_id, claim_key),
  check (not computed or computation is not null)
);
create trigger research_claims_immutable before update or delete on smb.research_claims
  for each row execute function smb.immutable_except();

create table smb.research_claim_sources (
  claim_id         uuid not null references smb.research_claims(id),
  source_record_id uuid not null references smb.source_records(id),
  primary key (claim_id, source_record_id)
);
create index research_claim_sources_record on smb.research_claim_sources (source_record_id);
create trigger research_claim_sources_immutable before update or delete on smb.research_claim_sources
  for each row execute function smb.immutable_except();
