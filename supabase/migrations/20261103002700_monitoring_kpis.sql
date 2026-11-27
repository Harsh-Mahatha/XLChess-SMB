-- Module 1.19: monitoring, cost and quality KPIs.
--
--  * smb.jobs keeps how long each job really ran (summed over attempts, failed ones included) and what the
--    model used, so a cost per post can be worked out.
--  * smb.review_actions keeps how long the reviewer actively looked at the post before acting.
--  * smb.cost_rates holds the prices behind the cost figures. Append-only: a change is a new row, so a past
--    period is always priced at the rates of its own time.
--  * smb.review_outcome_metrics adds the 1.19 columns to smb.review_outcomes without changing that view.

alter table smb.jobs
  add column attempt_started_at timestamptz,                 -- when the current (or last) attempt was claimed
  add column duration_ms        bigint not null default 0 check (duration_ms >= 0),  -- compute time, all attempts
  add column usage              jsonb;                       -- what the last attempt used (see JobUsage)

alter table smb.review_actions
  add column active_seconds integer check (active_seconds is null or active_seconds between 0 and 7200);

create table smb.cost_rates (
  id                     uuid primary key default gen_random_uuid(),
  effective_from         date not null unique,
  currency               text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  gpu_watts              numeric not null default 0 check (gpu_watts >= 0),         -- average draw while a GPU job runs
  electricity_per_kwh    numeric not null default 0 check (electricity_per_kwh >= 0),
  server_monthly         numeric not null default 0 check (server_monthly >= 0),    -- hosting, Supabase, storage
  x_api_monthly          numeric not null default 0 check (x_api_monthly >= 0),
  reviewer_hourly        numeric not null default 0 check (reviewer_hourly >= 0),
  reason                 text not null default '',
  created_by             text not null default 'system',
  created_at             timestamptz not null default now()
);
create trigger cost_rates_immutable before update or delete on smb.cost_rates
  for each row execute function smb.immutable_except();
-- Prices start at zero on purpose: a figure nobody set is reported as unpriced, never guessed.
insert into smb.cost_rates (effective_from, gpu_watts, reason) values ('2026-01-01', 250, 'initial');

-- Extra per-opportunity facts for the KPI figures. One row for each row of smb.review_outcomes.
--
--  clean           approved exactly as first written, with no regeneration, rewrite request or research request.
--                  This is what the ten-day streak counts.
--  image_flagged   a reviewer used an image tag (wrong_image, image_quality, image_crop) on any action or edit.
--  image_replaced  the approved post uses different photographs than the first text of the same candidate.
--  active_review_seconds  time reviewers reported looking at the post, summed over their actions (null if none).
create view smb.review_outcome_metrics with (security_invoker = true) as
select
  o.*,
  (o.approved_unedited and o.regenerations = 0 and o.revise_requests = 0 and o.research_requests = 0) as clean,
  coalesce(img.flagged, false)  as image_flagged,
  coalesce(img.replaced, false) as image_replaced,
  act.active_review_seconds
from smb.review_outcomes o
left join lateral (
  select
    exists (
      select 1 from smb.review_actions a
      where a.opportunity_id = o.opportunity_id
        and a.feedback_tags && array['wrong_image', 'image_quality', 'image_crop']
    ) or exists (
      select 1 from smb.post_revisions r
      join smb.post_candidates c on c.id = r.candidate_id
      where c.opportunity_id = o.opportunity_id and r.author_kind = 'human'
        and r.change_tags && array['wrong_image', 'image_quality', 'image_crop']
    ) as flagged,
    case when o.approved_revision_id is null then false else
      (select coalesce(array_agg(x.asset_id order by x.asset_id), '{}')
         from smb.revision_assets x where x.revision_id = o.approved_revision_id and x.role <> 'graphic')
      is distinct from
      (select coalesce(array_agg(x.asset_id order by x.asset_id), '{}')
         from smb.revision_assets x
         join smb.post_revisions r1 on r1.id = x.revision_id and r1.revision_no = 1
         where r1.candidate_id = o.approved_candidate_id and x.role <> 'graphic')
    end as replaced
) img on true
left join lateral (
  select sum(a.active_seconds)::int as active_review_seconds
  from smb.review_actions a
  where a.opportunity_id = o.opportunity_id and a.active_seconds is not null
) act on true;
