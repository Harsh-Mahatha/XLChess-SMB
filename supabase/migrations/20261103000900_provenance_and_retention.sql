-- Module 1.2 (9/9): end-to-end provenance view and retention rules.

-- One row per publication, traced back through approval, revision, candidate, generation (prompt/model/job),
-- research claims with their source records, assets with their original + licence, and the exact config version.
create view smb.publication_provenance with (security_invoker = true) as
select
  p.id                      as publication_id,
  p.channel,
  p.mode,
  p.status                  as publication_status,
  p.external_id,
  p.url                     as publication_url,
  p.published_at,
  p.content_hash            as published_hash,
  a.id                      as approval_id,
  a.reviewer_id,
  a.created_at              as approved_at,
  a.content_hash            as approved_hash,
  r.id                      as revision_id,
  r.revision_no,
  r.author_kind,
  r.author_id,
  r.template_version,
  r.created_at              as revision_created_at,
  c.id                      as candidate_id,
  c.slot,
  c.generation_cycle,
  c.provider,
  c.model,
  c.prompt_version,
  c.job_id                  as generation_job_id,
  o.id                      as opportunity_id,
  o.dedupe_key,
  o.trigger_kind,
  o.created_at              as opportunity_created_at,
  o.post_type_id,
  cfg.id                    as post_config_id,
  cfg.version               as config_version,
  cfg.content_hash          as config_hash,
  rp.id                     as research_package_id,
  rp.version                as research_package_version,
  rp.content_hash           as research_package_hash,
  claims.items              as claims,
  assets.items              as assets,
  history.items             as history
from smb.publications p
join smb.review_actions a   on a.id = p.approval_id
join smb.post_revisions r   on r.id = p.revision_id
join smb.post_candidates c  on c.id = r.candidate_id
join smb.post_opportunities o on o.id = c.opportunity_id
join smb.post_configs cfg   on cfg.id = o.post_config_id
join smb.research_packages rp on rp.id = c.research_package_id
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object(
    'claim_key', cl.claim_key,
    'value', cl.value,
    'computed', cl.computed,
    'computation', cl.computation,
    'verification', cl.verification,
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'source_record_id', sr.id,
        'source_id', sr.source_id,
        'url', sr.url,
        'retrieved_at', sr.retrieved_at,
        'event_time', sr.event_time,
        'payload_hash', sr.payload_hash
      ) order by sr.retrieved_at), '[]'::jsonb)
      from smb.research_claim_sources rcs
      join smb.source_records sr on sr.id = rcs.source_record_id
      where rcs.claim_id = cl.id
    )
  ) order by cl.claim_key), '[]'::jsonb) as items
  from smb.revision_claims rc
  join smb.research_claims cl on cl.id = rc.claim_id
  where rc.revision_id = r.id
) claims
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', m.id,
    'role', ra.role,
    'kind', m.kind,
    'sha256', m.sha256,
    'path', m.bucket || '/' || m.path,
    'parent_asset_id', m.parent_asset_id,
    'transform', m.transform,
    'template_version', m.template_version,
    'original_asset_id', root.id,
    'original_sha256', root.sha256,
    'original_source_url', root.source_url,
    'original_source_page_url', root.source_page_url,
    'licences', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'licence_id', l.id,
        'licence_type', l.licence_type,
        'licence_version', l.licence_version,
        'licence_url', l.licence_url,
        'decision', l.decision,
        'commercial_use_allowed', l.commercial_use_allowed,
        'modifications_allowed', l.modifications_allowed,
        'attribution_required', l.attribution_required,
        'attribution_text', l.attribution_text,
        'photographer', l.photographer,
        'copyright_holder', l.copyright_holder,
        'evidence_asset_id', l.evidence_asset_id,
        'verified_at', l.verified_at,
        'verified_by', l.verified_by
      ) order by l.verified_at), '[]'::jsonb)
      from smb.media_licenses l
      where l.asset_id = root.id
    )
  ) order by m.created_at), '[]'::jsonb) as items
  from smb.revision_assets ra
  join smb.media_assets m on m.id = ra.asset_id
  join smb.media_assets root on root.id = smb.asset_root(m.id)
  where ra.revision_id = r.id
) assets
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object(
    'from', e.from_status,
    'to', e.to_status,
    'actor', e.actor,
    'reason', e.reason,
    'at', e.created_at
  ) order by e.seq), '[]'::jsonb) as items
  from smb.opportunity_events e
  where e.opportunity_id = o.id
) history;

-- ---------------------------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------------------------
create table smb.retention_policies (
  subject     text primary key,
  keep_days   integer not null check (keep_days > 0),
  enabled     boolean not null default true,
  description text not null,
  updated_at  timestamptz not null default now()
);
create trigger retention_policies_updated_at before update on smb.retention_policies
  for each row execute function smb.set_updated_at();

insert into smb.retention_policies (subject, keep_days, description) values
  ('source_raw_payload', 90, 'Raw external source payloads are purged; URL, hash and normalised record are kept'),
  ('unused_image',       30, 'Downloaded originals and derived images that never reached an approved revision'),
  ('unused_render',      30, 'Rendered graphics that never reached an approved revision'),
  ('job_payload',        30, 'Payload/result of finished jobs; the job row itself is kept');

-- Assets that must never be removed: anything used by a revision that was approved or published,
-- every ancestor of such an asset, and the licence evidence belonging to them. Evidence assets are always kept.
create function smb.protected_asset_ids() returns setof uuid
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
    select m.parent_asset_id from smb.media_assets m join keep k on m.id = k.id where m.parent_asset_id is not null
  )
  select id from keep
  union
  select l.evidence_asset_id from smb.media_licenses l
   where l.evidence_asset_id is not null and l.asset_id in (select id from keep)
$$;

-- Marks expired data as removed. It never hard-deletes provenance rows; the caller removes the files
-- for every media_assets row that now has deleted_at set (see the asset-storage module).
create function smb.apply_retention(p_now timestamptz default now())
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
       and m.kind in ('original', 'derived')
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
