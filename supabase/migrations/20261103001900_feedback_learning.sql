-- Module 1.12 (2/2): revisions and feedback learning.
--
--  * smb.post_revisions records what a revision changed and why: which fields, whether the change was a factual
--    correction or a creative improvement, the reviewer's tags, and (for a rewrite by the model) the feedback
--    it answered, the checks it went through and the prompt and model that wrote it.
--  * smb.post_candidates records which regeneration request a cycle answered.
--  * smb.story_selections may hold more than one row per package: a reviewer who rejects the angle gets a new
--    selection that leaves the rejected angles out.
--  * smb.review_outcomes: one row per opportunity that reached review, for the quality figures.

alter table smb.post_revisions
  add column change_kind      text check (change_kind in ('factual', 'creative', 'mixed', 'binding', 'ai_revision')),
  add column changed_fields   text[] not null default '{}',   -- 'headline', 'caption', 'altText', 'channel:x', ...
  add column change_tags      text[] not null default '{}',
  add column review_action_id uuid references smb.review_actions(id),  -- the feedback an AI rewrite answered
  add column validation       jsonb,                          -- an AI rewrite's deterministic checks
  add column generation       jsonb,                          -- an AI rewrite's provider, model, prompt version, settings
  add constraint post_revisions_ai_revision_check
    check (change_kind is distinct from 'ai_revision' or (author_kind = 'ai' and review_action_id is not null));
create index post_revisions_review_action on smb.post_revisions (review_action_id);

alter table smb.post_candidates
  add column feedback_action_id uuid references smb.review_actions(id);  -- the regenerate request this cycle answered

alter table smb.review_actions
  add constraint review_actions_revise_check
    check (action <> 'revise' or (candidate_id is not null and revision_id is not null
      and (feedback is not null or cardinality(feedback_tags) > 0)));

-- Story selection after a reviewer rejected the angle.
alter table smb.story_selections
  add column review_action_id uuid references smb.review_actions(id),  -- the regenerate request that asked for it
  add column excluded_angles  text[] not null default '{}';
alter table smb.story_selections
  drop constraint story_selections_opportunity_id_research_package_id_key;
-- Re-running a retried selection job still changes nothing; one more selection per reviewer request.
create unique index story_selections_first on smb.story_selections (opportunity_id, research_package_id)
  where review_action_id is null;
create unique index story_selections_review_action on smb.story_selections (review_action_id)
  where review_action_id is not null;

-- Provenance: the story is the one the published candidate was written for, now that a package can have several.
create or replace view smb.publication_provenance with (security_invoker = true) as
select
  b.*,
  s.id               as story_selection_id,
  s.angle_id         as story_angle_id,
  s.score            as story_score,
  s.reason           as story_reason,
  s.selector_version as story_selector_version
from smb.publication_provenance_base b
join smb.post_candidates c on c.id = b.candidate_id
left join smb.story_selections s
  on s.id = coalesce(
       c.story_selection_id,
       (select f.id from smb.story_selections f
         where f.opportunity_id = b.opportunity_id
           and f.research_package_id = b.research_package_id
           and f.review_action_id is null));

-- One row per opportunity that reached review. Nothing is left out: rejected and still-waiting opportunities are
-- rows too, so a rate computed from this view cannot hide the difficult posts.
--
-- "Unedited" means the approved text is the text the model first wrote for that candidate (revision 1). The
-- revision that approval makes to carry the graphic changes no text, so it does not count as an edit.
create view smb.review_outcomes with (security_invoker = true) as
select
  o.id            as opportunity_id,
  o.post_type_id,
  o.phase,
  o.status,
  case
    when o.status in ('approved', 'scheduled', 'publishing', 'published', 'partially_published') then 'approved'
    when o.status = 'rejected' then 'rejected'
    when o.status in ('awaiting_review', 'deferred', 'generating', 'researching') then 'pending'
    else 'other'
  end             as outcome,
  ready.first_at  as first_ready_at,
  case
    when o.status in ('approved', 'scheduled', 'publishing', 'published', 'partially_published') then ap.created_at
    when o.status = 'rejected' then rej.created_at
  end             as decided_at,
  ap.id           as approval_id,
  ap.candidate_id as approved_candidate_id,
  ap.revision_id  as approved_revision_id,
  ac.slot         as approved_slot,
  ac.approach     as approved_approach,
  ac.generation_cycle as approved_cycle,
  coalesce(ac.angle, lc.angle)                   as angle,
  coalesce(ac.prompt_version, lc.prompt_version) as prompt_version,
  coalesce(ac.model, lc.model)                   as model,
  coalesce(lc.generation_cycle, 0)               as generation_cycles,
  (ap.id is not null and o.status in ('approved', 'scheduled', 'publishing', 'published', 'partially_published')
    and ar.headline is not distinct from r1.headline
    and ar.caption = r1.caption
    and ar.channel_texts = r1.channel_texts
    and ar.alt_text is not distinct from r1.alt_text) as approved_unedited,
  acts.regenerations,
  acts.revise_requests,
  acts.research_requests,
  acts.defers,
  edits.human_edits,
  edits.factual_edits,
  edits.creative_edits,
  edits.unclassified_edits,
  edits.ai_revisions
from smb.post_opportunities o
join lateral (
  select min(e.created_at) as first_at
  from smb.opportunity_events e
  where e.opportunity_id = o.id and e.to_status = 'awaiting_review'
) ready on ready.first_at is not null
left join lateral (
  select a.* from smb.review_actions a
  where a.opportunity_id = o.id and a.action = 'approve'
  order by a.created_at desc, a.id limit 1
) ap on true
left join lateral (
  select a.created_at from smb.review_actions a
  where a.opportunity_id = o.id and a.action = 'reject'
  order by a.created_at desc, a.id limit 1
) rej on true
left join smb.post_candidates ac on ac.id = ap.candidate_id
left join smb.post_revisions ar on ar.id = ap.revision_id
left join smb.post_revisions r1 on r1.candidate_id = ap.candidate_id and r1.revision_no = 1
left join lateral (
  select c.angle, c.prompt_version, c.model, c.generation_cycle
  from smb.post_candidates c
  where c.opportunity_id = o.id
  order by c.generation_cycle desc, c.slot limit 1
) lc on true
cross join lateral (
  select
    count(*) filter (where a.action = 'regenerate')       as regenerations,
    count(*) filter (where a.action = 'revise')           as revise_requests,
    count(*) filter (where a.action = 'request_research') as research_requests,
    count(*) filter (where a.action = 'defer')            as defers
  from smb.review_actions a
  where a.opportunity_id = o.id
) acts
cross join lateral (
  -- A human edit is a human revision whose text differs from the revision it was made from.
  select
    count(*) filter (where r.author_kind = 'human')                                           as human_edits,
    count(*) filter (where r.author_kind = 'human' and r.change_kind in ('factual', 'mixed'))  as factual_edits,
    count(*) filter (where r.author_kind = 'human' and r.change_kind in ('creative', 'mixed')) as creative_edits,
    count(*) filter (where r.author_kind = 'human' and r.change_kind is null)                  as unclassified_edits,
    count(*) filter (where r.author_kind = 'ai')                                               as ai_revisions
  from smb.post_revisions r
  join smb.post_candidates c on c.id = r.candidate_id
  join smb.post_revisions p on p.id = r.parent_revision_id
  where c.opportunity_id = o.id
    and (r.headline is distinct from p.headline
      or r.caption <> p.caption
      or r.channel_texts <> p.channel_texts
      or r.alt_text is distinct from p.alt_text)
) edits;
