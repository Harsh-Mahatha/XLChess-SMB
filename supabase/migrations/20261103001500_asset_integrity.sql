-- Module 1.9 (2/2): original photo integrity and asset storage.
--  * Derived images may only record permitted transforms (crop, rotate, resize, encode).
--  * Provenance rules for derived, render and generated assets.
--  * smb.asset_integrity_checks: append-only record of every hash and rebuild check.
--  * Storage buckets for derived images, renders and generated decorative images.
--  * purged_at: the file has been removed from Storage (retention).

-- The shape of a derived asset's transform. Mirrors PhotoTransform in packages/shared (the code validates the
-- values in detail; this refuses unknown steps even if a writer skips the code).
create function smb.transform_is_permitted(t jsonb) returns boolean
language sql immutable as $$
  select coalesce(
    t is not null
    and jsonb_typeof(t) = 'object'
    and t->>'spec' = '1'
    and not exists (select 1 from jsonb_object_keys(t) k where k not in ('spec', 'crop', 'rotate', 'resize', 'encode'))
    and jsonb_typeof(t->'encode') = 'object'
    and (t->'encode'->>'format') in ('jpeg', 'png', 'webp')
    and not exists (select 1 from jsonb_object_keys(t->'encode') k where k not in ('format', 'quality'))
    and (t->'crop' is null or (jsonb_typeof(t->'crop') = 'object'
         and not exists (select 1 from jsonb_object_keys(t->'crop') k where k not in ('left', 'top', 'width', 'height'))))
    and (t->'rotate' is null or (jsonb_typeof(t->'rotate') = 'object'
         and not exists (select 1 from jsonb_object_keys(t->'rotate') k where k not in ('degrees', 'background'))))
    and (t->'resize' is null or (jsonb_typeof(t->'resize') = 'object'
         and (t->'resize'->>'fit') in ('inside', 'cover')
         and not exists (select 1 from jsonb_object_keys(t->'resize') k where k not in ('width', 'height', 'fit'))))
  , false)  -- a missing key must mean 'no', not NULL (a CHECK treats NULL as passing)
$$;

alter table smb.media_assets
  add column generation jsonb,        -- generated assets: model, prompt, seed, workflow; always text-only input
  add column purged_at  timestamptz;  -- the file was removed from Storage

alter table smb.media_assets
  add constraint media_assets_transform_permitted
    check (kind <> 'derived' or smb.transform_is_permitted(transform)),
  add constraint media_assets_size_known
    check (kind not in ('derived', 'render') or (width is not null and height is not null)),
  -- Originals, evidence and generated images start a chain; only derived images and renders have a parent.
  add constraint media_assets_parent_kind
    check (kind in ('derived', 'render') or parent_asset_id is null),
  add constraint media_assets_bucket_kind
    check (bucket = case kind
      when 'original' then 'originals'
      when 'evidence' then 'evidence'
      when 'derived' then 'derived'
      when 'render' then 'renders'
      when 'generated' then 'generated'
    end),
  -- An AI-made image has no photograph behind it: no parent, no source URL, and its generation record
  -- states that the model received text only.
  add constraint media_assets_generated_rules
    check (kind <> 'generated' or (
      generation is not null
      and parent_asset_id is null
      and source_url is null
      and generation->>'input' = 'text_only'
      and generation ? 'model' and generation ? 'prompt' and generation ? 'seed'
    )),
  add constraint media_assets_generation_only_generated
    check (kind = 'generated' or generation is null),
  add constraint media_assets_purge_needs_delete
    check (purged_at is null or deleted_at is not null);

-- A derived image or render may be cut from an original or another derived image, never from a render,
-- evidence or an AI-made image (so no AI output can sit between a photograph and what is published).
create function smb.media_assets_parent_guard() returns trigger
language plpgsql as $$
declare
  parent_kind smb.asset_kind;
begin
  if new.parent_asset_id is null then return new; end if;
  select kind into parent_kind from smb.media_assets where id = new.parent_asset_id;
  if parent_kind is null or parent_kind not in ('original', 'derived') then
    raise exception 'a % asset cannot be made from a % asset', new.kind, coalesce(parent_kind::text, 'missing')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger media_assets_parent before insert on smb.media_assets
  for each row execute function smb.media_assets_parent_guard();

drop trigger media_assets_guard on smb.media_assets;
create trigger media_assets_guard before update or delete on smb.media_assets
  for each row execute function smb.immutable_except('deleted_at', 'retention_until', 'purged_at');

-- An AI-made decorative image contains no photograph, so it has no licence to check.
-- Everything else is judged by its original photograph, as before (module 1.8).
create or replace function smb.asset_licence_problem(p_asset uuid) returns text
language plpgsql stable as $$
declare
  a    smb.media_assets;
  root smb.media_assets;
  lic  smb.media_licenses;
begin
  select * into a from smb.media_assets where id = p_asset;
  if not found then return 'the asset does not exist'; end if;
  if a.deleted_at is not null then return 'the asset was deleted'; end if;
  if a.kind = 'evidence' then return 'licence evidence cannot be used in a post'; end if;
  if a.kind = 'generated' then return null; end if;
  if a.kind = 'render' and a.parent_asset_id is null then return null; end if;

  select * into root from smb.media_assets where id = smb.asset_root(p_asset);
  if root.kind <> 'original' then return 'the asset does not trace back to an original photograph'; end if;
  if root.deleted_at is not null then return 'the original photograph was deleted'; end if;

  select * into lic from smb.media_licenses
   where asset_id = root.id
   order by created_at desc, verified_at desc, id desc
   limit 1;
  if not found then return 'the original photograph has no licence record'; end if;
  if lic.decision <> 'accepted' then return 'the licence was rejected: ' || coalesce(lic.decision_reason, 'no reason recorded'); end if;
  if not lic.commercial_use_allowed then return 'the licence does not allow commercial use'; end if;
  if not lic.modifications_allowed then return 'the licence does not allow modifications'; end if;
  if lic.attribution_required and lic.attribution_text is null then return 'the licence requires attribution and none is recorded'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Integrity checks
-- ---------------------------------------------------------------------------------------------
create table smb.asset_integrity_checks (
  id             uuid primary key default gen_random_uuid(),
  asset_id       uuid not null references smb.media_assets(id),
  check_kind     text not null check (check_kind in ('original_hash', 'derived_rebuild', 'region_match')),
  passed         boolean not null,
  failures       text[] not null default '{}',
  detail         jsonb not null default '{}',   -- measurements: hashes, PSNR, worst block, sizes
  engine         jsonb not null default '{}',   -- sharp / libvips versions that did the work
  policy_version text not null,                 -- INTEGRITY_POLICY_VERSION
  checked_at     timestamptz not null default clock_timestamp(),
  check (passed = (cardinality(failures) = 0))
);
create index asset_integrity_checks_asset on smb.asset_integrity_checks (asset_id, checked_at desc);
create trigger asset_integrity_checks_immutable before update or delete on smb.asset_integrity_checks
  for each row execute function smb.immutable_except();

-- Why an asset's integrity is not established, or null when it is. An original needs a passing hash check; a
-- derived image needs a passing rebuild check and an intact original. Renders that contain a photograph are
-- judged by their newest region_match check (module 1.10). The newest check of each kind decides.
create function smb.asset_integrity_problem(p_asset uuid) returns text
language plpgsql stable as $$
declare
  a    smb.media_assets;
  root smb.media_assets;
  c    smb.asset_integrity_checks;
begin
  select * into a from smb.media_assets where id = p_asset;
  if not found then return 'the asset does not exist'; end if;
  if a.kind in ('evidence', 'generated') then return null; end if;
  if a.kind = 'render' and a.parent_asset_id is null then return null; end if;

  select * into root from smb.media_assets where id = smb.asset_root(p_asset);
  if root.kind <> 'original' then return 'the asset does not trace back to an original photograph'; end if;

  select * into c from smb.asset_integrity_checks
   where asset_id = root.id and check_kind = 'original_hash'
   order by checked_at desc, id desc limit 1;
  if not found then return 'the original photograph has not been hash-checked'; end if;
  if not c.passed then return 'the original photograph failed its hash check: ' || array_to_string(c.failures, ', '); end if;

  if a.kind = 'derived' then
    select * into c from smb.asset_integrity_checks
     where asset_id = a.id and check_kind = 'derived_rebuild'
     order by checked_at desc, id desc limit 1;
    if not found then return 'the derived image has not been checked against its original'; end if;
    if not c.passed then return 'the derived image failed its check: ' || array_to_string(c.failures, ', '); end if;
  elsif a.kind = 'render' then
    select * into c from smb.asset_integrity_checks
     where asset_id = a.id and check_kind = 'region_match'
     order by checked_at desc, id desc limit 1;
    if not found then return 'the photograph area of the render has not been checked'; end if;
    if not c.passed then return 'the render changed the photograph: ' || array_to_string(c.failures, ', '); end if;
  end if;
  return null;
end $$;

-- Private buckets, service role only, content-addressed like the originals.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
      ('derived',   'derived',   false, 52428800, array['image/jpeg', 'image/png', 'image/webp']),
      ('renders',   'renders',   false, 52428800, array['image/jpeg', 'image/png', 'image/webp']),
      ('generated', 'generated', false, 52428800, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;

-- Retention: unused AI-made images expire with the other unused images.
create or replace function smb.apply_retention(p_now timestamptz default now())
returns table (subject text, affected bigint)
language plpgsql as $$
declare
  days integer;
  n bigint;
begin
  select keep_days into days from smb.retention_policies where retention_policies.subject = 'source_raw_payload' and enabled;
  if found then
    update smb.source_records
       set raw_payload = null, raw_purged_at = p_now
     where raw_payload is not null and retrieved_at < p_now - make_interval(days => days);
    get diagnostics n = row_count;
    subject := 'source_raw_payload'; affected := n; return next;
  end if;

  select keep_days into days from smb.retention_policies where retention_policies.subject = 'unused_image' and enabled;
  if found then
    update smb.media_assets m
       set deleted_at = p_now
     where m.deleted_at is null
       and m.kind in ('original', 'derived', 'generated')
       and coalesce(m.retention_until, m.created_at + make_interval(days => days)) < p_now
       and m.id not in (select smb.protected_asset_ids());
    get diagnostics n = row_count;
    subject := 'unused_image'; affected := n; return next;
  end if;

  select keep_days into days from smb.retention_policies where retention_policies.subject = 'unused_render' and enabled;
  if found then
    update smb.media_assets m
       set deleted_at = p_now
     where m.deleted_at is null
       and m.kind = 'render'
       and coalesce(m.retention_until, m.created_at + make_interval(days => days)) < p_now
       and m.id not in (select smb.protected_asset_ids());
    get diagnostics n = row_count;
    subject := 'unused_render'; affected := n; return next;
  end if;

  select keep_days into days from smb.retention_policies where retention_policies.subject = 'job_payload' and enabled;
  if found then
    update smb.jobs
       set payload = '{}', result = null, payload_purged_at = p_now
     where payload_purged_at is null
       and status in ('succeeded', 'dead', 'cancelled', 'expired')
       and finished_at < p_now - make_interval(days => days);
    get diagnostics n = row_count;
    subject := 'job_payload'; affected := n; return next;
  end if;
end $$;
