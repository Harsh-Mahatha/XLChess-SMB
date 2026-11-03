-- Module 1.2 (2/9): post types, versioned configurations, approved sources, retrieved records.

create table smb.post_types (
  id          text primary key,                       -- stable id, e.g. '1.1'
  name        text not null,
  description text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger post_types_updated_at before update on smb.post_types
  for each row execute function smb.set_updated_at();

create table smb.post_configs (
  id            uuid primary key default gen_random_uuid(),
  post_type_id  text not null references smb.post_types(id),
  version       integer not null check (version > 0),
  config_json   jsonb not null,
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  origin        text not null check (origin in ('file', 'override')),
  is_active     boolean not null default false,
  created_by    text,                                  -- XLChess user id for overrides
  created_at    timestamptz not null default now(),
  unique (post_type_id, version)
);
-- At most one active config per post type.
create unique index post_configs_one_active on smb.post_configs (post_type_id) where is_active;
-- A config version never changes; only the active flag moves.
create trigger post_configs_immutable before update or delete on smb.post_configs
  for each row execute function smb.immutable_except('is_active');

create table smb.data_sources (
  id         text primary key,                         -- 'D1'.. data, 'I1'.. image
  kind       text not null check (kind in ('data', 'image')),
  name       text not null,
  base_url   text,
  terms_url  text,
  enabled    boolean not null default true,
  config     jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger data_sources_updated_at before update on smb.data_sources
  for each row execute function smb.set_updated_at();

create table smb.source_records (
  id             uuid primary key default gen_random_uuid(),
  source_id      text not null references smb.data_sources(id),
  url            text not null,
  retrieved_at   timestamptz not null,
  event_time     timestamptz,
  adapter_version text,
  raw_payload    jsonb,                                -- purged by retention; hash is kept
  payload_hash   text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  normalised     jsonb not null,
  raw_purged_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index source_records_source_retrieved on smb.source_records (source_id, retrieved_at desc);
create trigger source_records_immutable before update or delete on smb.source_records
  for each row execute function smb.immutable_except('raw_payload', 'raw_purged_at');
