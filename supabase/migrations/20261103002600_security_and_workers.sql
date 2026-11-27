-- Module 1.18: paired workers, device tokens, pairing codes, publish-mode setting, approver role.

create table smb.workers (
  id              uuid primary key default gen_random_uuid(),
  label           text,
  hostname        text not null,
  os              text not null default '',
  worker_version  text not null,
  gpu             jsonb,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status          jsonb,                       -- last POST /worker/v1/status body
  paused          boolean not null default false,
  update_required boolean not null default false,
  paired_at       timestamptz not null default now(),
  paired_by       text,                        -- XLChess user id that made the pairing code
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      text,
  revoke_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((revoked_at is null) = (revoked_by is null))
);
create trigger workers_updated_at before update on smb.workers
  for each row execute function smb.set_updated_at();

create table smb.worker_pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  label       text,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  worker_id   uuid references smb.workers(id),
  check ((used_at is null) = (worker_id is null)),
  check (expires_at > created_at)
);

update smb.jobs set leased_by = null where leased_by is not null and status <> 'leased';
alter table smb.jobs
  add constraint jobs_leased_by_fk foreign key (leased_by) references smb.workers(id);
create index jobs_leased_by on smb.jobs (leased_by) where status = 'leased';

-- One row: the publish mode an administrator chose. The environment caps it (docs/ARCHITECTURE.md section 8).
create table smb.publish_settings (
  id          boolean primary key default true check (id),
  mode        smb.publish_mode not null default 'dry_run',
  updated_by  text not null default 'system',
  reason      text not null default 'initial',
  updated_at  timestamptz not null default now()
);
insert into smb.publish_settings (id) values (true);

alter table smb.review_actions
  add column actor_role text check (actor_role is null or actor_role in ('reviewer', 'admin'));
