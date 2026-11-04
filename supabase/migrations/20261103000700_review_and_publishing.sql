-- Module 1.2 (7/9): reviewer actions, approvals, and per-channel publications.
-- Edits are not actions: an edit creates a new post_revisions row (author_kind = 'human').

create table smb.review_actions (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references smb.post_opportunities(id),
  candidate_id    uuid references smb.post_candidates(id),
  revision_id     uuid references smb.post_revisions(id),
  action          smb.review_action_type not null,
  content_hash    text check (content_hash ~ '^[0-9a-f]{64}$'),   -- hash of the revision as the reviewer saw it
  reviewer_id     text not null,                                  -- XLChess user id (no cross-project FK)
  channels        smb.channel[] not null default '{}',
  scheduled_for   timestamptz,
  feedback        text,
  feedback_tags   text[] not null default '{}',
  idempotency_key text unique,
  created_at      timestamptz not null default now(),
  check (action <> 'approve' or (revision_id is not null and content_hash is not null and cardinality(channels) > 0)),
  check (action not in ('reject', 'defer') or feedback is not null or cardinality(feedback_tags) > 0)
);
create index review_actions_opportunity on smb.review_actions (opportunity_id, created_at);
create index review_actions_revision on smb.review_actions (revision_id);
create trigger review_actions_immutable before update or delete on smb.review_actions
  for each row execute function smb.immutable_except();

-- Approval binding: an approval must carry the exact hash of the revision it approves,
-- and that revision must belong to the same opportunity.
create function smb.check_approval_binding() returns trigger
language plpgsql as $$
declare
  rev record;
begin
  if new.action <> 'approve' then
    return new;
  end if;
  select r.content_hash, c.opportunity_id into rev
  from smb.post_revisions r join smb.post_candidates c on c.id = r.candidate_id
  where r.id = new.revision_id;
  if not found then
    raise exception 'approval references an unknown revision %', new.revision_id;
  end if;
  if rev.content_hash <> new.content_hash then
    raise exception 'approval hash does not match revision % (content changed after review)', new.revision_id;
  end if;
  if rev.opportunity_id <> new.opportunity_id then
    raise exception 'revision % does not belong to opportunity %', new.revision_id, new.opportunity_id;
  end if;
  return new;
end $$;
create trigger review_actions_approval_binding before insert on smb.review_actions
  for each row execute function smb.check_approval_binding();

create table smb.publications (
  id              uuid primary key default gen_random_uuid(),
  approval_id     uuid not null references smb.review_actions(id),
  revision_id     uuid not null references smb.post_revisions(id),
  channel         smb.channel not null,
  mode            smb.publish_mode not null,
  status          smb.publication_status not null default 'pending',
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  scheduled_for   timestamptz,
  external_id     text,                                  -- e.g. tweet id
  url             text,
  published_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (approval_id, channel),                         -- each channel has its own row and status
  check (status <> 'published' or (external_id is not null and published_at is not null))
);
create index publications_status on smb.publications (status, scheduled_for);
create index publications_revision on smb.publications (revision_id);
create trigger publications_guard before update or delete on smb.publications
  for each row execute function smb.immutable_except('status', 'external_id', 'url', 'published_at', 'last_error', 'updated_at');
create trigger publications_updated_at before update on smb.publications
  for each row execute function smb.set_updated_at();

-- A publication can only point at an approval of the same revision, hash and channel.
create function smb.check_publication_binding() returns trigger
language plpgsql as $$
declare
  a record;
begin
  select action, revision_id, content_hash, channels into a from smb.review_actions where id = new.approval_id;
  if not found or a.action <> 'approve' then
    raise exception 'publication must reference an approve action';
  end if;
  if a.revision_id <> new.revision_id or a.content_hash <> new.content_hash then
    raise exception 'publication revision/hash does not match the approval';
  end if;
  if not (new.channel = any (a.channels)) then
    raise exception 'channel % was not approved', new.channel;
  end if;
  return new;
end $$;
create trigger publications_binding before insert on smb.publications
  for each row execute function smb.check_publication_binding();

-- One row per try, so retries never overwrite earlier failures.
create table smb.publication_attempts (
  id               uuid primary key default gen_random_uuid(),
  publication_id   uuid not null references smb.publications(id),
  attempt_no       integer not null check (attempt_no > 0),
  outcome          text not null check (outcome in ('success', 'failure', 'timeout', 'dry_run')),
  request_summary  jsonb not null default '{}',          -- never contains credentials
  response_summary jsonb not null default '{}',
  error            text,
  job_id           uuid references smb.jobs(id),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz not null default now(),
  unique (publication_id, attempt_no)
);
create trigger publication_attempts_immutable before update or delete on smb.publication_attempts
  for each row execute function smb.immutable_except();
