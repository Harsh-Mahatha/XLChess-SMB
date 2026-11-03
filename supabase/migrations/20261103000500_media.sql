-- Module 1.2 (5/9): original and generated assets, and licence evidence.

create table smb.media_assets (
  id               uuid primary key default gen_random_uuid(),
  kind             smb.asset_kind not null,
  bucket           text not null,
  path             text not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime             text not null,
  size_bytes       bigint check (size_bytes >= 0),
  width            integer check (width > 0),
  height           integer check (height > 0),
  source_url       text,                                  -- where an original was downloaded from
  source_page_url  text,
  image_source_id  text references smb.data_sources(id),
  parent_asset_id  uuid references smb.media_assets(id),  -- what a derived asset was cut from
  transform        jsonb,                                 -- crop / resize / rotate / position only
  template_version text,                                  -- for renders
  opportunity_id   uuid references smb.post_opportunities(id),
  job_id           uuid references smb.jobs(id),
  retention_until  timestamptz,
  deleted_at       timestamptz,                           -- soft delete; the file is removed from Storage
  created_at       timestamptz not null default now(),
  unique (bucket, path),
  -- Provenance rules: an original knows where it came from; a derived asset knows what it came from.
  check (kind <> 'original' or (source_url is not null and image_source_id is not null)),
  check (kind <> 'derived' or (parent_asset_id is not null and transform is not null)),
  check (kind <> 'render' or template_version is not null)
);
create index media_assets_parent on smb.media_assets (parent_asset_id);
create index media_assets_sha256 on smb.media_assets (sha256);
create trigger media_assets_guard before update or delete on smb.media_assets
  for each row execute function smb.immutable_except('deleted_at', 'retention_until');

-- Root original of a (possibly multi-step) derived asset.
create function smb.asset_root(p_asset uuid) returns uuid
language sql stable as $$
  with recursive chain as (
    select id, parent_asset_id, 0 as depth from smb.media_assets where id = p_asset
    union all
    select m.id, m.parent_asset_id, c.depth + 1
    from smb.media_assets m join chain c on m.id = c.parent_asset_id
  )
  select id from chain where parent_asset_id is null order by depth desc limit 1
$$;

create table smb.media_licenses (
  id                      uuid primary key default gen_random_uuid(),
  asset_id                uuid not null references smb.media_assets(id),
  original_url            text not null,
  source_page_url         text,
  photographer            text,
  copyright_holder        text,
  licence_type            text not null,
  licence_version         text,
  licence_url             text,
  commercial_use_allowed  boolean not null,
  modifications_allowed   boolean not null,
  attribution_required    boolean not null,
  attribution_text        text,
  share_alike             boolean not null default false,
  other_obligations       text,
  evidence_asset_id       uuid references smb.media_assets(id),   -- saved copy of the licence page / terms
  evidence_note           text,
  decision                smb.licence_decision not null,
  decision_reason         text,
  verified_at             timestamptz not null,
  verified_by             text not null,                          -- XLChess user id or 'system'
  created_at              timestamptz not null default now(),
  check (decision <> 'rejected' or decision_reason is not null),
  -- Only a fully evidenced, commercially usable licence can be accepted.
  check (decision <> 'accepted' or (
    commercial_use_allowed
    and (licence_url is not null or evidence_asset_id is not null)
    and (not attribution_required or attribution_text is not null)
  ))
);
create index media_licenses_asset on smb.media_licenses (asset_id);
create trigger media_licenses_immutable before update or delete on smb.media_licenses
  for each row execute function smb.immutable_except();
