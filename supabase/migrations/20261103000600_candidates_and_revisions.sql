-- Module 1.2 (6/9): generated candidates and their immutable revisions.

create table smb.post_candidates (
  id                  uuid primary key default gen_random_uuid(),
  opportunity_id      uuid not null references smb.post_opportunities(id),
  research_package_id uuid not null references smb.research_packages(id),
  generation_cycle    integer not null default 1 check (generation_cycle > 0),
  slot                text not null check (slot in ('A', 'B', 'C')),   -- three candidates per cycle
  angle               text,
  provider            text not null,                                   -- 'ollama' | 'stub'
  model               text,
  prompt_version      text not null,
  job_id              uuid references smb.jobs(id),
  created_at          timestamptz not null default now(),
  unique (opportunity_id, generation_cycle, slot)
);
create trigger post_candidates_immutable before update or delete on smb.post_candidates
  for each row execute function smb.immutable_except();

create table smb.post_revisions (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references smb.post_candidates(id),
  revision_no        integer not null check (revision_no > 0),
  parent_revision_id uuid references smb.post_revisions(id),
  caption            text not null,
  channel_texts      jsonb not null default '{}',
  template_version   text,
  content_hash       text not null check (content_hash ~ '^[0-9a-f]{64}$'),  -- sha256(caption, channel texts, asset hashes, template)
  author_kind        text not null check (author_kind in ('ai', 'human')),
  author_id          text,                                                   -- XLChess user id for human edits
  change_note        text,
  created_at         timestamptz not null default now(),
  unique (candidate_id, revision_no),
  check (author_kind <> 'human' or author_id is not null),
  check ((revision_no = 1) = (parent_revision_id is null))
);
create index post_revisions_hash on smb.post_revisions (content_hash);
create trigger post_revisions_immutable before update or delete on smb.post_revisions
  for each row execute function smb.immutable_except();

create table smb.revision_claims (
  revision_id uuid not null references smb.post_revisions(id),
  claim_id    uuid not null references smb.research_claims(id),
  primary key (revision_id, claim_id)
);
create trigger revision_claims_immutable before update or delete on smb.revision_claims
  for each row execute function smb.immutable_except();

create table smb.revision_assets (
  revision_id uuid not null references smb.post_revisions(id),
  asset_id    uuid not null references smb.media_assets(id),
  role        text not null default 'image',            -- 'photo' | 'graphic' | 'image'
  primary key (revision_id, asset_id)
);
create index revision_assets_asset on smb.revision_assets (asset_id);
create trigger revision_assets_immutable before update or delete on smb.revision_assets
  for each row execute function smb.immutable_except();
