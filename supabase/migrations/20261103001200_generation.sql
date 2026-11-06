-- Module 1.7: what generation records about each candidate.
-- post_candidates is append-only, so a candidate is written once with everything below.

alter table smb.post_candidates
  add column story_selection_id uuid references smb.story_selections(id),  -- the story this candidate tells
  add column approach            text check (approach in ('factual', 'narrative', 'engagement')),
  add column prompt_versions     jsonb not null default '{}',   -- stage -> 'id@semver#hash'
  add column generation_settings jsonb not null default '{}',   -- stage -> temperature, seed, context size
  add column output              jsonb,                         -- the structured draft as the model returned it
  add column validation          jsonb,                         -- deterministic checks: passed + every issue
  add column editorial           jsonb,                         -- the model's own review (advisory)
  add column visual_plan         jsonb;                         -- template, composition notes, alt text
create index post_candidates_story on smb.post_candidates (story_selection_id);

alter table smb.post_revisions
  add column headline text,
  add column alt_text text;
