-- Module 1.2 (8/9): quality / performance measurements and the privileged-action audit log.

create table smb.post_metrics (
  id           uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('opportunity', 'candidate', 'revision', 'publication', 'job', 'system')),
  subject_id   uuid,
  metric       text not null,                            -- e.g. 'unedited_approval', 'generation_seconds', 'impressions'
  value        numeric not null,
  unit         text,
  dimensions   jsonb not null default '{}',
  measured_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  check (subject_type = 'system' or subject_id is not null)
);
create index post_metrics_subject on smb.post_metrics (subject_type, subject_id, metric);
create index post_metrics_metric_time on smb.post_metrics (metric, measured_at desc);
create trigger post_metrics_immutable before update or delete on smb.post_metrics
  for each row execute function smb.immutable_except();

create table smb.audit_log (
  id          bigint generated always as identity primary key,
  actor       text not null,                             -- XLChess user id, worker id or 'system'
  action      text not null,                             -- 'approve', 'publish_mode.change', 'config.override', ...
  target_type text,
  target_id   text,
  details     jsonb not null default '{}',               -- must not contain secrets
  created_at  timestamptz not null default now()
);
create index audit_log_target on smb.audit_log (target_type, target_id);
create index audit_log_actor_time on smb.audit_log (actor, created_at desc);
create trigger audit_log_immutable before update or delete on smb.audit_log
  for each row execute function smb.immutable_except();
