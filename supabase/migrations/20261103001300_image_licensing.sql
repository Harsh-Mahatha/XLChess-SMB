-- Module 1.8: image discovery and licence checks.
--  * smb.image_candidates: every photo considered for an opportunity and why it was kept or dropped.
--    A rejected photo is logged here only; its file is never downloaded or stored.
--  * smb.asset_licence_problem(): the rule "an unlicensed image cannot enter publication".
--  * A trigger on revision_assets that enforces that rule.
--  * Private Storage buckets for original photographs and licence evidence.

-- Re-verifying a photo writes a new licence row and the newest decides. now() is fixed per transaction,
-- so use clock_timestamp() to keep rows written in one transaction in order.
alter table smb.media_licenses alter column created_at set default clock_timestamp();
alter table smb.media_licenses
  add column policy_version  text,      -- which licence rules made the decision (LICENCE_POLICY_VERSION)
  add column rejection_codes text[] not null default '{}';

create table smb.image_candidates (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references smb.post_opportunities(id),
  image_source_id text not null references smb.data_sources(id),
  external_id     text not null,                        -- the provider's id, e.g. 'File:Gukesh.jpg'
  title           text not null,
  page_url        text not null,
  image_url       text not null,
  mime            text not null,
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  subject         jsonb not null,                       -- what the photo was searched for
  match_kind      text not null check (match_kind in ('wikidata_image', 'category', 'search')),
  decision        smb.licence_decision not null,
  rejection_codes text[] not null default '{}',
  decision_reason text,
  eligible        boolean not null,                     -- passed size / type / identity checks
  score           numeric(5, 3) not null,
  score_detail    jsonb not null,
  chosen          boolean not null default false,       -- stored and offered to the opportunity
  evidence        jsonb not null,                       -- the licence facts exactly as the provider gave them
  policy_version  text not null,
  scorer_version  text not null,
  asset_id        uuid references smb.media_assets(id), -- the stored original, when chosen
  license_id      uuid references smb.media_licenses(id),
  created_at      timestamptz not null default clock_timestamp(),
  unique (opportunity_id, image_source_id, external_id),
  check (decision <> 'rejected' or decision_reason is not null),
  -- Only a licence-approved, eligible photo can be chosen, and a chosen photo has its stored file and licence.
  check (not chosen or (decision = 'accepted' and eligible and asset_id is not null and license_id is not null))
);
create index image_candidates_opportunity on smb.image_candidates (opportunity_id);
create index image_candidates_asset on smb.image_candidates (asset_id);
create trigger image_candidates_immutable before update or delete on smb.image_candidates
  for each row execute function smb.immutable_except();

-- Why an asset may not be used in a post, or null when it may.
-- A derived asset or render is judged by the original photograph it came from. The photograph's newest licence
-- row must be accepted, allow commercial use and allow modification (every photo is cropped and resized).
-- A render with no parent contains no photograph. A render that contains one must name it as its parent (1.10).
create function smb.asset_licence_problem(p_asset uuid) returns text
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

create function smb.asset_licence_ok(p_asset uuid) returns boolean
language sql stable as $$ select smb.asset_licence_problem(p_asset) is null $$;

create function smb.revision_assets_licence_guard() returns trigger
language plpgsql as $$
declare
  problem text := smb.asset_licence_problem(new.asset_id);
begin
  if problem is not null then
    raise exception 'asset % cannot be used in a revision: %', new.asset_id, problem
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger revision_assets_licence before insert on smb.revision_assets
  for each row execute function smb.revision_assets_licence_guard();

-- Private buckets, service role only. Paths are content-addressed (<sha256>.<ext>), so a path proves which
-- file it holds. The derived and render buckets come with module 1.9. Skipped where Storage is not installed.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
      ('originals', 'originals', false, 52428800, array['image/jpeg', 'image/png', 'image/webp']),
      ('evidence', 'evidence', false, 5242880, array['application/json', 'text/html', 'text/plain'])
    on conflict (id) do nothing;
  end if;
end $$;
