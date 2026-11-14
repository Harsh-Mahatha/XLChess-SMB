-- Module 1.10: graphics. A render can contain several photographs (player-versus-player has two), and a
-- candidate can have a render per aspect ratio.
--
--  * smb.render_sources: which photographs a render contains, where, and how they were scaled into place.
--  * smb.candidate_renders: the renders made for a candidate (append-only). Approval binding is module 1.11.
--  * Licence, integrity and retention now look at every photograph of a render, not only `parent_asset_id`.
--    A render still names its first photograph as `parent_asset_id`, so earlier rules keep working.

create table smb.render_sources (
  render_id  uuid not null references smb.media_assets(id),
  slot       text not null check (slot ~ '^[a-z][a-z0-9_]{0,39}$'),
  source_id  uuid not null references smb.media_assets(id),   -- an original or derived photograph
  left_px    integer not null check (left_px >= 0),
  top_px     integer not null check (top_px >= 0),
  width_px   integer not null check (width_px > 0),
  height_px  integer not null check (height_px > 0),
  fit        text not null check (fit in ('inside', 'cover')),
  created_at timestamptz not null default now(),
  primary key (render_id, slot)
);
create index render_sources_source on smb.render_sources (source_id);

create function smb.render_sources_guard() returns trigger
language plpgsql as $$
declare
  r_kind smb.asset_kind;
  s_kind smb.asset_kind;
begin
  select kind into r_kind from smb.media_assets where id = new.render_id;
  select kind into s_kind from smb.media_assets where id = new.source_id;
  if r_kind is distinct from 'render' then
    raise exception 'asset % is not a render', new.render_id using errcode = 'check_violation';
  end if;
  if s_kind is null or s_kind not in ('original', 'derived') then
    raise exception 'a render can only contain an original or derived photograph, not a % asset', coalesce(s_kind::text, 'missing')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger render_sources_check before insert on smb.render_sources
  for each row execute function smb.render_sources_guard();
create trigger render_sources_immutable before update or delete on smb.render_sources
  for each row execute function smb.immutable_except();

create table smb.candidate_renders (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid not null references smb.post_candidates(id),
  render_asset_id  uuid not null references smb.media_assets(id),
  template_id      text not null,
  template_version text not null,
  aspect           text not null,
  render_key       text not null check (render_key ~ '^[0-9a-f]{64}$'),   -- sha256 of every input
  created_at       timestamptz not null default now(),
  unique (candidate_id, aspect, render_key)
);
create index candidate_renders_candidate on smb.candidate_renders (candidate_id, aspect);
create trigger candidate_renders_immutable before update or delete on smb.candidate_renders
  for each row execute function smb.immutable_except();

-- Every asset a given asset was made from: its parent and, for a render, each photograph it contains.
create view smb.asset_edges as
  select id as child_id, parent_asset_id as parent_id from smb.media_assets where parent_asset_id is not null
  union
  select render_id, source_id from smb.render_sources;

-- ---------------------------------------------------------------------------------------------
-- Licence: judge one original photograph, then every photograph in a render.
-- ---------------------------------------------------------------------------------------------
create function smb.original_licence_problem(p_asset uuid) returns text
language plpgsql stable as $$
declare
  root smb.media_assets;
  lic  smb.media_licenses;
begin
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

create or replace function smb.asset_licence_problem(p_asset uuid) returns text
language plpgsql stable as $$
declare
  a smb.media_assets;
  s record;
  p text;
begin
  select * into a from smb.media_assets where id = p_asset;
  if not found then return 'the asset does not exist'; end if;
  if a.deleted_at is not null then return 'the asset was deleted'; end if;
  if a.kind = 'evidence' then return 'licence evidence cannot be used in a post'; end if;
  if a.kind = 'generated' then return null; end if;
  if a.kind = 'render' then
    -- A render with no photograph has no licence to check; each photograph it contains is judged on its own.
    for s in
      select parent_id as source_id from smb.asset_edges where child_id = p_asset
      order by 1
    loop
      p := smb.original_licence_problem(s.source_id);
      if p is not null then return p; end if;
    end loop;
    return null;
  end if;
  return smb.original_licence_problem(p_asset);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Integrity: a render needs a passing region check for every photograph it contains.
-- ---------------------------------------------------------------------------------------------
create function smb.photo_integrity_problem(p_asset uuid, p_require_derived boolean default true) returns text
language plpgsql stable as $$
declare
  a    smb.media_assets;
  root smb.media_assets;
  c    smb.asset_integrity_checks;
begin
  select * into a from smb.media_assets where id = p_asset;
  select * into root from smb.media_assets where id = smb.asset_root(p_asset);
  if root.kind <> 'original' then return 'the asset does not trace back to an original photograph'; end if;

  select * into c from smb.asset_integrity_checks
   where asset_id = root.id and check_kind = 'original_hash'
   order by checked_at desc, id desc limit 1;
  if not found then return 'the original photograph has not been hash-checked'; end if;
  if not c.passed then return 'the original photograph failed its hash check: ' || array_to_string(c.failures, ', '); end if;

  if a.kind = 'derived' and p_require_derived then
    select * into c from smb.asset_integrity_checks
     where asset_id = a.id and check_kind = 'derived_rebuild'
     order by checked_at desc, id desc limit 1;
    if not found then return 'the derived image has not been checked against its original'; end if;
    if not c.passed then return 'the derived image failed its check: ' || array_to_string(c.failures, ', '); end if;
  end if;
  return null;
end $$;

create or replace function smb.asset_integrity_problem(p_asset uuid) returns text
language plpgsql stable as $$
declare
  a smb.media_assets;
  s record;
  c smb.asset_integrity_checks;
  p text;
begin
  select * into a from smb.media_assets where id = p_asset;
  if not found then return 'the asset does not exist'; end if;
  if a.kind in ('evidence', 'generated') then return null; end if;

  if a.kind <> 'render' then return smb.photo_integrity_problem(p_asset); end if;

  for s in
    select parent_id as source_id from smb.asset_edges where child_id = p_asset order by 1
  loop
    -- A photograph recorded in render_sources must be proven all the way back; a render that only names a parent
    -- (made before 1.10) is judged by the original's hash and the region check, as in module 1.9.
    p := smb.photo_integrity_problem(
      s.source_id,
      exists (select 1 from smb.render_sources rs where rs.render_id = p_asset and rs.source_id = s.source_id));
    if p is not null then return p; end if;
    -- The newest region check for this photograph. Checks recorded without a source id belong to the parent.
    select * into c from smb.asset_integrity_checks
     where asset_id = a.id and check_kind = 'region_match'
       and (detail->>'sourceId' = s.source_id::text
            or (detail->>'sourceId' is null and s.source_id = a.parent_asset_id))
     order by checked_at desc, id desc limit 1;
    if not found then return 'the photograph area of the render has not been checked'; end if;
    if not c.passed then return 'the render changed the photograph: ' || array_to_string(c.failures, ', '); end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Retention: keep every photograph a used render was made from.
-- ---------------------------------------------------------------------------------------------
create or replace function smb.protected_asset_ids() returns setof uuid
language sql stable as $$
  with recursive used as (
    select ra.asset_id as id
    from smb.revision_assets ra
    where exists (select 1 from smb.review_actions a where a.revision_id = ra.revision_id and a.action = 'approve')
       or exists (select 1 from smb.publications p where p.revision_id = ra.revision_id)
  ),
  keep(id) as (
    select id from used
    union
    select e.parent_id from smb.asset_edges e join keep k on e.child_id = k.id
  )
  select id from keep
  union
  select l.evidence_asset_id from smb.media_licenses l
   where l.evidence_asset_id is not null and l.asset_id in (select id from keep)
$$;
