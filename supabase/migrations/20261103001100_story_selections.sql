-- Module 1.6: story selection records and the `skipped` opportunity status.

-- An opportunity for which there is no worthwhile post (nothing fresh, supported and different enough).
-- Kept apart from `failed` (something broke) and `rejected` (a reviewer said no).
-- The new value is not used in this file: Postgres only allows that after the enum change has committed.
alter type smb.opportunity_status add value 'skipped' before 'failed';

-- One row per selection run. The ranking keeps the score breakdown and the rejection reasons of every
-- angle so a reviewer can see why a story was chosen, and why the others were not.
create table smb.story_selections (
  id                  uuid primary key default gen_random_uuid(),
  opportunity_id      uuid not null references smb.post_opportunities(id),
  research_package_id uuid not null references smb.research_packages(id),
  outcome             text not null check (outcome in ('selected', 'no_worthwhile_post')),
  angle_id            text,
  fingerprint         text check (fingerprint ~ '^[0-9a-f]{64}$'),  -- sha256 of the angle and its features
  features            jsonb not null default '[]',                   -- what the story is about, compared with history
  score               numeric(4, 3) check (score between 0 and 1),
  reason              text not null,
  ranking             jsonb not null default '[]',
  selector_version    text not null,
  job_id              uuid references smb.jobs(id),
  created_at          timestamptz not null default now(),
  unique (opportunity_id, research_package_id),                      -- re-running a retried job changes nothing
  check ((outcome = 'selected') = (angle_id is not null and fingerprint is not null and score is not null))
);
create index story_selections_recent on smb.story_selections (created_at desc) where outcome = 'selected';
create trigger story_selections_immutable before update or delete on smb.story_selections
  for each row execute function smb.immutable_except();

-- Provenance now also says which story was chosen and why. The previous view is kept under a new name
-- and extended, so its definition is not repeated.
alter view smb.publication_provenance rename to publication_provenance_base;
create view smb.publication_provenance with (security_invoker = true) as
select
  b.*,
  s.id               as story_selection_id,
  s.angle_id         as story_angle_id,
  s.score            as story_score,
  s.reason           as story_reason,
  s.selector_version as story_selector_version
from smb.publication_provenance_base b
left join smb.story_selections s
  on s.opportunity_id = b.opportunity_id
 and s.research_package_id = b.research_package_id;
